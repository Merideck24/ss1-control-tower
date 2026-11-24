import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, onboard, ev, T } from './helpers.ts';
import { route } from '../src/api/router.ts';
import { DAY, HOUR } from '../src/shared/util.ts';

const author = { id: 'ana@ss1', tenant_id: T };
const approver = { id: 'apr@ss1', tenant_id: T };
const banner = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, placement: 'home_banner' as const, purpose: 'marketing' as const, rules: { field: 'kyc', op: 'eq', value: 'verified' } as const,
  content: { es: { title: 'Torneo semanal', body: 'Suma puntos con cada apuesta.', cta_label: 'Ver torneo', cta_url: 'https://www.rumbawin.com/torneos' } },
  priority: 50, starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-12-31T00:00:00Z', max_impressions_per_day: 2, ...extra,
});
function live(app: ReturnType<typeof setup>['app'], c: ReturnType<typeof banner>) {
  app.onsite.save(author, c as never); app.onsite.submit(author, c.id); return app.onsite.approve(approver, c.id);
}

test('F3: validación de contenido seguro, enlaces de la marca y separación de funciones', () => {
  const { app } = setup();
  assert.throws(() => app.onsite.save(author, banner('bad', { content: { es: { title: '<b>x</b>', body: 'y', cta_label: 'Ir', cta_url: 'http://evil.example.com' } } }) as never), /sin HTML.*https y de un dominio de la marca/);
  assert.throws(() => app.onsite.save(author, banner('bad2', { rules: { field: 'nope', op: 'eq', value: 1 } }) as never), /campo «nope»/);
  assert.throws(() => app.onsite.save(author, banner('bad3', { ends_at: '2026-10-01T00:00:00Z' }) as never), /vigencia/);
  app.onsite.save(author, banner('ok') as never); app.onsite.submit(author, 'ok');
  assert.throws(() => app.onsite.approve(author, 'ok'), /no puede aprobarla/);
  assert.equal(app.onsite.approve(approver, 'ok').status, 'active');
  assert.throws(() => app.onsite.save(author, banner('ok') as never), /Pausa la campaña/);
  assert.deepEqual(app.audit.list(T).filter((a) => a.action.startsWith('onsite.')).map((a) => a.action), ['onsite.saved', 'onsite.submitted', 'onsite.approved']);
});

test('F3: segmento, prioridad, tope diario, descarte y política (consentimiento, juego responsable)', () => {
  const { app, clock } = setup();
  live(app, banner('low', { priority: 10 }));
  live(app, banner('high', { priority: 90, max_impressions_per_day: 1 }));
  live(app, banner('unverified', { priority: 99, rules: { field: 'kyc', op: 'eq', value: 'pending' } }));
  onboard(app, clock, 'p');
  const serve = (id: string, rid: string) => app.onsite.serve(app.ingestor.get(T, id)!, 'home_banner', { request_id: rid });
  const a = serve('p', 'r1');
  assert.equal(a.campaign_id, 'high', 'gana la prioridad mayor dentro del segmento');
  assert.ok(a.skipped.some((x) => x.campaign_id === 'unverified' && x.reason === 'fuera_del_segmento'));
  assert.equal(serve('p', 'r2').campaign_id, 'low', 'tope diario de la de mayor prioridad ⇒ sigue la siguiente');
  app.onsite.track(T, 'p', { campaign_id: 'low', type: 'dismiss', request_id: 'r2' });
  const none = serve('p', 'r3');
  assert.equal(none.campaign_id, null);
  assert.ok(none.skipped.some((x) => x.reason === 'descartada_por_el_jugador'));
  clock.advance(DAY + HOUR); app.policy.markRgFeedSynced(T);
  assert.equal(serve('p', 'r4').campaign_id, 'high', 'al día siguiente vuelve; la descartada sigue oculta 7 días');
  // consentimiento in-app retirado o restricción JR ⇒ nada de marketing en el sitio
  app.ingestor.ingest(ev(T, 'p', 'consent.changed', { purpose: 'marketing', channel: 'inapp', granted: false }, clock.now().toISOString()));
  assert.equal(serve('p', 'r5').campaign_id, null);
  onboard(app, clock, 'q');
  app.ingestor.ingest(ev(T, 'q', 'rg.status_changed', { status: 'self_excluded' }, clock.now().toISOString()));
  assert.ok(serve('q', 'r6').skipped.some((x) => /rg_restricted/.test(x.reason)));
  // servicio: aviso de límites sí se muestra a quien tiene restricción
  live(app, banner('limits', { placement: 'home_banner', purpose: 'service', priority: 1, rules: { field: 'rg', op: 'neq', value: 'none' }, content: { es: { title: 'Tus límites', body: 'Revisa tus herramientas de control.' } } }));
  assert.equal(serve('q', 'r7').campaign_id, 'limits');
});

test('F3: métricas idempotentes por solicitud y API con permisos', async () => {
  const { app, clock } = setup();
  live(app, banner('bb'));
  for (const id of ['p1', 'p2', 'p3']) onboard(app, clock, id);
  const call = (method: string, path: string, roles: string, body: Record<string, unknown> = {}) => route(app, { method, path: path.split('?')[0], query: new URLSearchParams(path.split('?')[1] ?? ''), headers: { 'x-tenant-id': T, 'x-roles': roles, 'x-actor': `${roles}@ss1` }, body });
  const s1 = (await call('GET', '/onsite/serve/p1?placement=home_banner&request_id=x1', 'support')).body as { campaign_id: string };
  assert.equal(s1.campaign_id, 'bb');
  await call('GET', '/onsite/serve/p1?placement=home_banner&request_id=x1', 'support'); // reintento del sitio
  await call('GET', '/onsite/serve/p2?placement=home_banner&request_id=x2', 'support');
  await call('POST', '/onsite/events/p1', 'support', { campaign_id: 'bb', type: 'click', request_id: 'x1' });
  await call('POST', '/onsite/events/p1', 'support', { campaign_id: 'bb', type: 'click', request_id: 'x1' });
  const list = (await call('GET', '/onsite/campaigns', 'crm_analyst')).body as { campaigns: { id: string; stats: { impressions: number; unique_players: number; clicks: number; ctr: number } }[] };
  assert.deepEqual(list.campaigns[0].stats, { impressions: 2, unique_players: 2, clicks: 1, ctr: 0.5, dismisses: 0 }, 'sin dobles conteos');
  assert.equal((await call('GET', '/onsite/campaigns', 'support')).status, 403);
  assert.equal((await call('GET', '/onsite/serve/p3?placement=nowhere', 'support')).status, 422);
  assert.equal((await call('POST', '/onsite/campaigns/bb/approve', 'crm_analyst')).status, 403);
  assert.equal((await call('POST', '/onsite/campaigns/bb/pause', 'rg_officer')).status, 200, 'JR puede pausar contenido');
  assert.equal(((await call('GET', '/onsite/serve/p3?placement=home_banner&request_id=x3', 'support')).body as { campaign_id: string | null }).campaign_id, null);
});

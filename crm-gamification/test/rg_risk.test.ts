import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, onboard, ev, T } from './helpers.ts';
import { route } from '../src/api/router.ts';
import { HOUR, DAY } from '../src/shared/util.ts';

const COP = (n: number) => ({ amount_minor: n * 100, currency: 'COP' });

function chaser(start = '2026-11-15T15:00:00Z') {
  const s = setup(start);
  onboard(s.app, s.clock, 'p');
  const at = () => s.clock.now().toISOString();
  // 5 depósitos en ~2 h, cada uno perdido casi por completo antes del siguiente
  for (let i = 0; i < 5; i++) {
    s.app.ingestor.ingest(ev(T, 'p', 'deposit.settled', { deposit_id: `d${i}`, ...COP(100_000) }, at()));
    s.clock.advance(10 * 60_000);
    s.app.ingestor.ingest(ev(T, 'p', 'bet.settled', { bet_id: `b${i}`, stake: COP(100_000), win: COP(5_000), product: 'casino' }, at()));
    s.clock.advance(15 * 60_000);
  }
  return s;
}
const call = (app: ReturnType<typeof setup>['app'], method: string, path: string, roles: string, body: Record<string, unknown> = {}) =>
  route(app, { method, path, query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': roles, 'x-actor': `${roles}@ss1` }, body });

test('I2: depósitos acelerados + persecución de pérdidas ⇒ caso alto explicado, una sola alerta y marketing en pausa', () => {
  const { app } = chaser();
  const cases = app.risk.cases(T);
  assert.equal(cases.length, 1, 'un caso, aunque las señales se repitan');
  assert.equal(cases[0].level, 'high');
  assert.deepEqual(cases[0].signals.map((s) => s.code).sort(), ['deposit_velocity', 'loss_chasing']);
  assert.ok(cases[0].signals.every((s) => s.detail.length > 30));
  assert.equal(app.ingestor.get(T, 'p')!.risk?.value, 'high', 'el perfil refleja el nivel');
  const signals = app.ingestor.get(T, 'p')!.timeline.filter((t) => t.event_type === 'rg.risk_signal');
  assert.ok(signals.length >= 1 && signals.length <= 2, 'medio → alto como mucho; sin repetir el mismo nivel en 24 h');
  const d = app.policy.decide({ profile: app.ingestor.get(T, 'p')!, purpose: 'marketing', channel: 'inapp' });
  assert.ok(d.reasons.includes('rg_risk_case_open'));
  assert.equal(app.policy.decide({ profile: app.ingestor.get(T, 'p')!, purpose: 'marketing', incentive: true }).kind, 'suppress');
});

test('D6: la intervención es de servicio: envía herramientas de control y nunca promoción', () => {
  const { app } = chaser();
  const inst = app.runtime.instances(T, { player_id: 'p', journey_id: 'jrg_intervention' });
  assert.ok(inst.length >= 1);
  const sent = app.channels.receipts(T, 'p').filter((r) => r.template.startsWith('rg_'));
  assert.ok(sent.some((r) => r.template === 'rg_limits_reminder' && r.channel === 'email' && r.status === 'accepted'), 'alto ⇒ recordatorio de límites por email');
  // la intervención llega aunque el jugador no tenga consentimiento de marketing
  const s2 = setup();
  onboard(s2.app, s2.clock, 'q', T, { email: false });
  s2.app.ingestor.ingest(ev(T, 'q', 'consent.changed', { purpose: 'marketing', channel: 'inapp', granted: false }, s2.clock.now().toISOString()));
  for (let i = 0; i < 4; i++) { s2.app.ingestor.ingest(ev(T, 'q', 'deposit.settled', { deposit_id: `q${i}`, ...COP(50_000) }, s2.clock.now().toISOString())); s2.clock.advance(HOUR); }
  const r = s2.app.channels.receipts(T, 'q').filter((x) => x.template.startsWith('rg_'));
  assert.ok(r.some((x) => x.template === 'rg_check_in' && x.status === 'accepted'), `medio ⇒ check-in in-app pese a no tener consentimiento de marketing: ${JSON.stringify(r)}`);
  // validación: no puede ser marketing ni llevar incentivos
  const author = { id: 'ana@ss1', tenant_id: T, roles: ['crm_analyst' as const] };
  app.registry.saveDraft(author, { id: 'bad_rg', brand_id: 'rumbawin', name: 'x', purpose: 'marketing', trigger: { event_type: 'rg.risk_signal' }, entry: 'g', nodes: [{ id: 'g', type: 'grant_reward', reward_id: 'welcome_fs_10', next: 'e' }, { id: 'e', type: 'exit' }] });
  assert.throws(() => app.registry.submit(author, 'bad_rg'), /rg_journey_must_be_service.*rg_journey_no_incentives_or_tests|rg_journey_no_incentives_or_tests.*rg_journey_must_be_service/);
});

test('I2: juego nocturno + apuestas en escalada ⇒ nivel medio; jugador normal sin alertas', () => {
  const s = setup('2026-11-01T15:00:00Z');
  onboard(s.app, s.clock, 'n'); onboard(s.app, s.clock, 'calm');
  const bet = (p: string, id: string, cop: number, iso: string) => s.app.ingestor.ingest(ev(T, p, 'bet.settled', { bet_id: id, stake: COP(cop), product: 'casino' }, iso));
  for (let i = 0; i < 25; i++) { bet('n', `h${i}`, 10_000, new Date(Date.parse('2026-11-01T16:00:00Z') + i * HOUR).toISOString()); bet('calm', `c${i}`, 10_000, new Date(Date.parse('2026-11-01T16:00:00Z') + i * HOUR).toISOString()); }
  s.clock.advance(10 * DAY); // 2026-11-11 15:00Z
  // tres noches seguidas a las 02:00 Bogotá (07:00Z); la última con 6 apuestas 5× mayores
  for (let n = 0; n < 3; n++) for (let i = 0; i < (n === 2 ? 6 : 2); i++) bet('n', `x${n}${i}`, n === 2 ? 50_000 : 10_000, new Date(Date.parse('2026-11-09T07:00:00Z') + n * DAY + i * 600_000).toISOString());
  bet('calm', 'c-day', 10_000, s.clock.now().toISOString());
  const a = s.app.risk.assess(T, 'n', 'America/Bogota');
  assert.deepEqual(a.signals.map((x) => x.code).sort(), ['escalating_stakes', 'night_play']);
  assert.equal(a.level, 'medium');
  assert.equal(s.app.risk.assess(T, 'calm', 'America/Bogota').level, 'none');
  assert.equal(s.app.risk.cases(T).filter((c) => c.player_id === 'calm').length, 0);
});

test('I2: cola del equipo JR con permisos, gestión auditada y fin de la pausa de marketing al cerrar', async () => {
  const { app } = chaser();
  const mon = (await call(app, 'GET', '/risk/rg-monitor', 'rg_officer')).body as { summary: { open: number; high: number; marketing_on_hold: number }; cases: { case_id: string }[] };
  assert.deepEqual([mon.summary.open, mon.summary.high, mon.summary.marketing_on_hold], [1, 1, 1]);
  assert.equal((await call(app, 'GET', '/risk/rg-monitor', 'crm_analyst')).status, 403, 'marketing no ve la cola de JR');
  const id = mon.cases[0].case_id;
  assert.equal((await call(app, 'POST', `/risk/rg-cases/${id}/take`, 'tenant_admin')).status, 403, 'solo el equipo JR gestiona');
  assert.equal((await call(app, 'POST', `/risk/rg-cases/${id}/take`, 'rg_officer')).status, 200);
  assert.equal((await call(app, 'POST', `/risk/rg-cases/${id}/close`, 'rg_officer', { outcome: 'contacted', note: '' })).status, 422);
  assert.equal((await call(app, 'POST', `/risk/rg-cases/${id}/close`, 'rg_officer', { outcome: 'limits_suggested', note: 'Llamada: acepta fijar límite diario' })).status, 200);
  assert.deepEqual(app.audit.list(T).filter((x) => x.action.startsWith('rg.case')).map((x) => x.action), ['rg.case_opened', 'rg.case_taken', 'rg.case_closed']);
  assert.ok(!app.policy.decide({ profile: app.ingestor.get(T, 'p')!, purpose: 'marketing', channel: 'inapp' }).reasons.includes('rg_risk_case_open'), 'caso cerrado: sin pausa');
  const prof = (await call(app, 'GET', '/players/p', 'rg_officer')).body as { rg_risk?: { cases: unknown[] } };
  assert.equal(prof.rg_risk?.cases.length, 1);
  assert.equal(((await call(app, 'GET', '/players/p', 'support')).body as { rg_risk?: unknown }).rg_risk, undefined);
});

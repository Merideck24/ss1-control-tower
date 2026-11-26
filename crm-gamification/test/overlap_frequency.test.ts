import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, onboard, ev, T } from './helpers.ts';
import { route } from '../src/api/router.ts';
import { DEFAULT_POLICY } from '../src/policy/policyEngine.ts';
import { HOUR, DAY } from '../src/shared/util.ts';
import type { JourneyDefinition } from '../src/journeys/model.ts';

type Draft = Omit<JourneyDefinition, 'version' | 'status' | 'created_by' | 'updated_at' | 'tenant_id'>;
const author = { id: 'ana@ss1', tenant_id: T, roles: ['crm_analyst' as const] };
const approver = { id: 'apr@ss1', tenant_id: T, roles: ['approver' as const] };

function publish(app: ReturnType<typeof setup>['app'], d: Draft) {
  app.registry.saveDraft(author, d); app.registry.submit(author, d.id); app.registry.approve(approver, d.id); app.registry.publish(author, d.id);
}
const waitMsg = (id: string, priority: number | undefined, group = 'promo', extra: Partial<Draft> = {}): Draft => ({
  id, brand_id: 'rumbawin', name: id, purpose: 'marketing', trigger: { event_type: 'deposit.settled' }, entry: 'w',
  ...(priority !== undefined ? { overlap: { group, priority } } : {}),
  nodes: [{ id: 'w', type: 'wait', duration_ms: 6 * HOUR, next: 'm' }, { id: 'm', type: 'message', channel: 'inapp', template: 'deposit_progress', next: 'e' }, { id: 'e', type: 'exit' }], ...extra,
});

test('D3: en el mismo grupo gana la prioridad mayor; el empate lo conserva quien ya está en curso', () => {
  const { app, clock } = setup();
  publish(app, waitMsg('low', 20)); publish(app, waitMsg('high', 80)); publish(app, waitMsg('tie', 80)); publish(app, waitMsg('other_group', 10, 'service_like'));
  onboard(app, clock, 'p');
  app.ingestor.ingest(ev(T, 'p', 'deposit.settled', { deposit_id: 'd1', amount_minor: 100_00, currency: 'COP' }, clock.now().toISOString()));
  const st = Object.fromEntries(app.runtime.instances(T, { player_id: 'p' }).map((i) => [i.journey_id, i.status]));
  assert.equal(st.low, 'preempted', 'la de menor prioridad cede');
  assert.equal(st.high, 'waiting');
  assert.equal(st.tie, 'blocked_overlap', 'empate: se queda la que ya estaba');
  assert.equal(st.other_group, 'waiting', 'otro grupo no compite');
  assert.equal(app.audit.list(T, { action: 'journey.instance_preempted' }).length, 1);
  assert.equal(app.audit.list(T, { action: 'journey.entry_blocked_overlap' }).length, 1);
  clock.advance(7 * HOUR); app.runtime.tick();
  const sent = app.channels.receipts(T, 'p').filter((r) => r.status === 'accepted');
  assert.equal(sent.length, 2, 'solo envían la ganadora y la del otro grupo; la desplazada nunca despierta');
});

test('D3: enfriamiento del grupo, recorridos de servicio exentos y validación de prioridad', () => {
  const { app, clock } = setup();
  publish(app, { ...waitMsg('first', 50), overlap: { group: 'promo', priority: 50, cooldown_hours: 48 }, nodes: [{ id: 'm', type: 'message', channel: 'inapp', template: 'deposit_progress', next: 'e' }, { id: 'e', type: 'exit' }], entry: 'm' });
  publish(app, { ...waitMsg('second', 90), trigger: { event_type: 'bet.settled' }, overlap: { group: 'promo', priority: 90, cooldown_hours: 48 } });
  onboard(app, clock, 'p');
  app.ingestor.ingest(ev(T, 'p', 'deposit.settled', { deposit_id: 'd1', amount_minor: 100_00, currency: 'COP' }, clock.now().toISOString()));
  clock.advance(HOUR);
  app.ingestor.ingest(ev(T, 'p', 'bet.settled', { bet_id: 'b1', stake: { amount_minor: 100_00, currency: 'COP' }, product: 'casino' }, clock.now().toISOString()));
  assert.equal(app.runtime.instances(T, { journey_id: 'second' })[0].status, 'blocked_overlap', 'dentro del enfriamiento de 48 h');
  clock.advance(2 * DAY);
  app.ingestor.ingest(ev(T, 'p', 'bet.settled', { bet_id: 'b2', stake: { amount_minor: 100_00, currency: 'COP' }, product: 'casino' }, clock.now().toISOString()));
  assert.equal(app.runtime.instances(T, { journey_id: 'second' }).at(-1)!.status, 'waiting');
  // validación
  assert.throws(() => { app.registry.saveDraft(author, { ...waitMsg('bad', 0), id: 'bad' }); app.registry.submit(author, 'bad'); }, /invalid_overlap/);
  assert.throws(() => { app.registry.saveDraft(author, { ...waitMsg('svc', 10), id: 'svc', purpose: 'service', nodes: [{ id: 'w', type: 'wait', duration_ms: HOUR, next: 'e' }, { id: 'e', type: 'exit' }] }); app.registry.submit(author, 'svc'); }, /service_journey_cannot_have_overlap/);
});

test('D4: tope diario por canal y semanal, además del global; motivo explícito', () => {
  const { app, clock } = setup();
  app.policy.setPolicy(T, { ...DEFAULT_POLICY, max_marketing_per_day: 5, max_marketing_per_day_by_channel: { email: 1 }, max_marketing_per_week: 3 });
  onboard(app, clock, 'p', T, { verify: false }); // sin verificar: no recibe la bienvenida (que ya enviaría mensajes)
  const p = () => app.ingestor.get(T, 'p')!;
  const d = (channel: 'email' | 'inapp') => app.policy.decide({ profile: p(), purpose: 'marketing', channel });
  assert.equal(d('email').kind, 'allow');
  app.policy.recordMarketingSend(p(), 'email');
  assert.deepEqual(d('email').reasons, ['frequency_cap_channel:email']);
  assert.equal(d('inapp').kind, 'allow', 'otro canal sigue disponible');
  app.policy.recordMarketingSend(p(), 'inapp');
  clock.advance(DAY + HOUR); app.policy.markRgFeedSynced(T);
  assert.equal(d('email').kind, 'allow', 'el tope por canal es de 24 h');
  app.policy.recordMarketingSend(p(), 'inapp');
  assert.ok(d('inapp').reasons.includes('frequency_cap_week'), '3 envíos en 7 días');
  assert.deepEqual(app.policy.frequency(p()), { last_24h: 1, last_7d: 3, by_channel_24h: { inapp: 1 } });
  assert.equal(app.policy.decide({ profile: p(), purpose: 'service', channel: 'email' }).kind, 'allow', 'servicio no cuenta para topes');
  clock.advance(7 * DAY); app.policy.markRgFeedSynced(T);
  assert.equal(d('inapp').kind, 'allow');
});

test('D3: el panel de solapamiento muestra grupos, bloqueos y riesgos de colisión', async () => {
  const { app, clock } = setup();
  publish(app, waitMsg('a', 40)); publish(app, waitMsg('b', 60)); publish(app, waitMsg('loose', undefined));
  onboard(app, clock, 'p');
  app.ingestor.ingest(ev(T, 'p', 'deposit.settled', { deposit_id: 'd1', amount_minor: 100_00, currency: 'COP' }, clock.now().toISOString()));
  const r = await route(app, { method: 'GET', path: '/journeys/overlap', query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': 'crm_analyst', 'x-actor': 'a' }, body: {} });
  const body = r.body as { groups: { group: string; journeys: { id: string; preempted: number }[] }[]; risks: { journeys: string[] }[] };
  assert.deepEqual(body.groups[0].journeys.map((j) => j.id), ['b', 'a'], 'ordenados por prioridad');
  assert.equal(body.groups[0].journeys.find((j) => j.id === 'a')!.preempted, 1);
  assert.ok(body.risks.some((x) => x.journeys.includes('loose') && x.journeys.includes('a')), 'mismo disparador sin grupo ⇒ riesgo');
});

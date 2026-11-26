/** Perfil 360: etapa del recorrido del jugador, pendientes y próxima acción permitida (nunca contradice la política). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/api/router.ts';
import { setup, onboard, ev, T } from './helpers.ts';

type JS = { stage: string; stages: { key: string; status: string }[]; pending: string[]; next_action: { kind: string; label: string; channel?: string; why: string } };
async function state(app: ReturnType<typeof setup>['app'], id: string): Promise<JS> {
  const r = await route(app, { method: 'GET', path: `/players/${id}`, query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': 'crm_analyst', 'x-actor': 'ana@ss1' }, body: {} });
  assert.equal(r.status, 200);
  return (r.body as { journey_state: JS }).journey_state;
}

test('Recorrido del jugador: KYC pendiente → recordar verificación sin incentivo', async () => {
  const { app, clock } = setup();
  onboard(app, clock, 'p1', T, { verify: false });
  const s = await state(app, 'p1');
  assert.equal(s.stage, 'verificacion');
  assert.equal(s.next_action.kind, 'servicio');
  assert.match(s.next_action.label, /verificación/);
  assert.ok(s.pending.some((x) => /KYC/.test(x)));
  assert.equal(s.stages.find((x) => x.key === 'registro')!.status, 'hecho');
  assert.equal(s.stages.find((x) => x.key === 'soporte')!.status, 'sin_fuente', 'sin fuente de soporte no se inventa un estado');
});

test('Recorrido del jugador: verificado sin depósito → invitar al primer depósito por un canal permitido', async () => {
  const { app, clock } = setup();
  onboard(app, clock, 'p1');
  // los mensajes de bienvenida ya cumplieron el tope del día: la acción lo dice
  const capped = await state(app, 'p1');
  assert.deepEqual([capped.stage, capped.next_action.kind], ['primer_deposito', 'ninguna']);
  assert.match(capped.next_action.label, /tope de mensajes/);
  clock.advance(25 * 3_600_000);
  app.policy.markRgFeedSynced(T);
  const s = await state(app, 'p1');
  assert.equal(s.stage, 'primer_deposito');
  assert.deepEqual([s.next_action.kind, s.next_action.label], ['marketing', 'Invitar al primer depósito']);
  assert.ok(s.next_action.channel && app.policy.decide({ profile: app.ingestor.get(T, 'p1')!, purpose: 'marketing', channel: s.next_action.channel as never }).kind === 'allow', 'el canal sugerido está permitido por la política');
});

test('Recorrido del jugador: deposita y apuesta → avanza de etapa', async () => {
  const { app, clock } = setup();
  onboard(app, clock, 'p1');
  const now = () => clock.now().toISOString();
  app.ingestor.ingest(ev(T, 'p1', 'deposit.settled', { deposit_id: 'd1', amount_minor: 5_000_000, currency: 'COP' }, now()));
  assert.equal((await state(app, 'p1')).stage, 'activacion');
  app.ingestor.ingest(ev(T, 'p1', 'bet.settled', { bet_id: 'b1', stake: { amount_minor: 100_000, currency: 'COP' }, product: 'casino' }, now()));
  const s = await state(app, 'p1');
  assert.ok(['recompensas', 'fidelidad'].includes(s.stage), s.stage);
  assert.equal(s.stages.find((x) => x.key === 'activacion')!.status, 'hecho');
});

test('Recorrido del jugador: autoexcluido → etapa baja, solo servicio, con el motivo', async () => {
  const { app, clock } = setup();
  onboard(app, clock, 'p1');
  app.ingestor.ingest(ev(T, 'p1', 'rg.status_changed', { status: 'self_excluded' }, clock.now().toISOString()));
  const s = await state(app, 'p1');
  assert.equal(s.stage, 'baja');
  assert.equal(s.next_action.kind, 'servicio');
  assert.match(s.next_action.why, /autoexclusión/);
  assert.equal(s.stages.find((x) => x.key === 'juego_responsable')!.status, 'bloqueado');
  assert.ok(!s.pending.some((x) => /consentimiento/.test(x)), 'no se sugiere pedir consentimientos a un autoexcluido');
});

test('Recorrido del jugador: sin consentimiento de marketing → no contactar, con el motivo', async () => {
  const { app, clock } = setup();
  const now = () => clock.now().toISOString();
  app.ingestor.ingest(ev(T, 'p9', 'player.registered', { email_masked: 'a***@mail.com', country: 'CO', locale: 'es', timezone: 'America/Bogota' }, now()));
  app.ingestor.ingest(ev(T, 'p9', 'rg.status_changed', { status: 'none' }, now()));
  app.ingestor.ingest(ev(T, 'p9', 'player.verified', { kyc_status: 'verified' }, now()));
  const s = await state(app, 'p9');
  assert.deepEqual([s.next_action.kind, s.next_action.label], ['ninguna', 'No contactar por marketing']);
  assert.ok(s.pending.some((x) => /Sin consentimiento de marketing/.test(x)));
});

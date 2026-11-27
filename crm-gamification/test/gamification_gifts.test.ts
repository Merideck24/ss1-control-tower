/**
 * Regalos instantáneos de punta a punta: crear → aprobar (otra persona) y asignar de forma determinista →
 * aviso en vivo → «Mis regalos» → reclamar una sola vez → recompensa confirmada. Y los bordes: juego
 * responsable al asignar y al reclamar, bono pendiente, vencimiento, cierre con revocación, aislamiento.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/api/router.ts';
import { setup, onboard, ev, T, T2 } from './helpers.ts';

type R = { status: number; body: any };
function world() {
  const { app, clock } = setup();
  const call = (method: string, path: string, roles: string, body: Record<string, unknown> = {}, tenant = T): Promise<R> =>
    route(app, { method, path, query: new URLSearchParams(), headers: { 'x-tenant-id': tenant, 'x-roles': roles, 'x-actor': `${roles.split(',')[0]}@ss1` }, body }) as Promise<R>;
  let n = 0;
  const emit = (player: string, type: string, payload: Record<string, unknown>) => app.ingestor.ingest(ev(T, player, type as never, payload as never, clock.now().toISOString(), { event_id: `g${++n}` }));
  const exp = (days = 7) => new Date(clock.now().getTime() + days * 86_400_000).toISOString();
  return { app, clock, call, emit, exp };
}
const gift = (o: Record<string, unknown>) => ({ id: 'regalo_bienvenida', brand_id: 'rumbawin', name: 'Regalo de bienvenida', message: 'Gracias por unirte: aquí tienes un detalle.', reward: { xp: 200, coins: 30 }, max_recipients: 100, ...o });

test('Regalos · flujo completo: crear → aprobar y asignar → aviso → Mis regalos → reclamar una vez → confirmado', async () => {
  const w = world();
  for (const p of ['r3', 'r1', 'r2']) onboard(w.app, w.clock, p);
  const d = await w.call('POST', '/gifts', 'crm_analyst', gift({ audience: { players: ['r3', 'r1', 'r2', 'r1'] }, expires_at: w.exp(), max_recipients: 2 }));
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.deepEqual(d.body.audience.players, ['r3', 'r1', 'r2'], 'sin duplicados');
  assert.equal((await w.call('POST', '/gifts/regalo_bienvenida/submit', 'crm_analyst')).status, 200);
  assert.equal((await w.call('POST', '/gifts/regalo_bienvenida/approve', 'crm_analyst')).status, 403, 'el analista no aprueba');
  const ap = await w.call('POST', '/gifts/regalo_bienvenida/approve', 'approver');
  assert.deepEqual([ap.status, ap.body.status, ap.body.assignment.assigned, ap.body.assignment.skipped], [200, 'active', 2, { over_capacity: 1 }]);
  assert.ok(ap.body.approval_signature);
  // asignación determinista: por id, hasta el cupo (r1 y r2; r3 queda fuera por cupo)
  assert.deepEqual(w.app.gifts.assignments(T, 'regalo_bienvenida').map((a) => a.player_id).sort(), ['r1', 'r2']);
  // aviso en vivo al jugador
  assert.ok(w.app.realtime.since(T, 'r1', 0).events.some((e) => e.type === 'gift.received'));
  assert.equal(w.app.realtime.since(T, 'r3', 0).events.filter((e) => e.type === 'gift.received').length, 0);
  // Mis regalos
  const mine = await w.call('GET', '/players/r1/gifts', 'support');
  assert.deepEqual(mine.body.map((g: any) => [g.gift_id, g.status]), [['regalo_bienvenida', 'available']]);
  assert.deepEqual((await w.call('GET', '/players/r3/gifts', 'support')).body, []);
  // reclamar dos veces a la vez: un solo efecto
  const xp0 = w.app.loyalty.balance(T, 'r1', '2026-Q4'), c0 = w.app.store.balance(T, 'r1');
  const [a, b] = await Promise.all([w.call('POST', '/players/r1/gifts/regalo_bienvenida/claim', 'support'), w.call('POST', '/players/r1/gifts/regalo_bienvenida/claim', 'support')]);
  assert.deepEqual([a.status, b.status, a.body.status, b.body.status], [200, 200, 'claimed', 'claimed']);
  assert.equal(w.app.loyalty.balance(T, 'r1', '2026-Q4') - xp0, 200, 'XP una sola vez');
  assert.equal(w.app.store.balance(T, 'r1') - c0, 30, 'monedas una sola vez');
  assert.equal(w.app.audit.list(T).filter((x) => x.action === 'gift.claimed').length, 1);
  assert.equal((await w.call('GET', '/players/r1/gifts', 'support')).body[0].reward_state.status, 'confirmed');
  // un jugador sin el regalo no lo puede reclamar
  assert.equal((await w.call('POST', '/players/r3/gifts/regalo_bienvenida/claim', 'support')).status, 404);
  const st = (await w.call('GET', '/gifts', 'crm_analyst')).body.items[0];
  assert.deepEqual([st.assigned, st.claimed, st.claim_rate, st.rewards_confirmed], [2, 1, 0.5, 1]);
  assert.ok((await w.call('GET', '/gifts', 'crm_analyst')).body.definitions.claim_rate);
});

test('Regalos · juego responsable: no se asigna con restricción o señal; si la señal llega después, queda en pausa', async () => {
  const w = world();
  for (const p of ['ok1', 'ok2', 'rg1', 'sig1']) onboard(w.app, w.clock, p);
  w.emit('rg1', 'rg.status_changed', { status: 'self_excluded' });
  w.emit('sig1', 'rg.risk_signal', { level: 'high', score: 0.9, signals: ['night_sessions'] });
  w.app.gifts.saveDraft({ id: 'ana@ss1', tenant_id: T }, gift({ id: 'reg_rg', audience: { segment: { field: 'country', op: 'eq', value: 'CO' } }, expires_at: w.exp() }) as never);
  w.app.gifts.submit({ id: 'ana@ss1', tenant_id: T }, 'reg_rg');
  const g = w.app.gifts.approve({ id: 'beto@ss1', tenant_id: T }, 'reg_rg');
  assert.deepEqual(w.app.gifts.assignments(T, 'reg_rg').map((a) => a.player_id).sort(), ['ok1', 'ok2']);
  assert.equal(g.assignment!.skipped.rg_restricted, 1);
  assert.equal(g.assignment!.skipped.vulnerability_signal, 1);
  // la señal llega después de asignar: al reclamar queda en pausa, sin efecto
  w.emit('ok2', 'rg.risk_signal', { level: 'high', score: 0.9, signals: ['chasing'] });
  const xp0 = w.app.loyalty.balance(T, 'ok2', '2026-Q4');
  const held = w.app.gifts.claim(T, 'ok2', 'reg_rg');
  assert.deepEqual([held.status, held.held_reason], ['held', 'vulnerability_signal']);
  assert.equal(w.app.loyalty.balance(T, 'ok2', '2026-Q4'), xp0, 'sin XP');
  // texto que invita a recuperar pérdidas: se rechaza
  assert.throws(() => w.app.gifts.saveDraft({ id: 'ana@ss1', tenant_id: T }, gift({ id: 'reg_mal', message: 'Recupera tus pérdidas con este regalo', audience: { players: ['ok1'] }, expires_at: w.exp() }) as never), /recuperar pérdidas/);
  // autor ≠ aprobador
  w.app.gifts.saveDraft({ id: 'ana@ss1', tenant_id: T }, gift({ id: 'reg_4o', audience: { players: ['ok1'] }, expires_at: w.exp() }) as never);
  w.app.gifts.submit({ id: 'ana@ss1', tenant_id: T }, 'reg_4o');
  assert.throws(() => w.app.gifts.approve({ id: 'ana@ss1', tenant_id: T }, 'reg_4o'), /no puede aprobarlo/);
});

test('Regalos · bono pendiente se confirma al conciliar; vencimiento y cierre revocan lo no reclamado', async () => {
  const w = world();
  for (const p of ['b1', 'b2', 'b3']) onboard(w.app, w.clock, p);
  const A = { id: 'ana@ss1', tenant_id: T }, B = { id: 'beto@ss1', tenant_id: T };
  w.app.gifts.saveDraft(A, gift({ id: 'reg_bono', reward: { reward_id: 'welcome_fs_10' }, audience: { players: ['b1', 'b2', 'b3'] }, expires_at: w.exp(2) }) as never);
  w.app.gifts.submit(A, 'reg_bono'); w.app.gifts.approve(B, 'reg_bono');
  (w.app.bonus as unknown as { timeoutNext: number }).timeoutNext = 1;
  assert.equal(w.app.gifts.claim(T, 'b1', 'reg_bono').reward!.status, 'pending');
  w.app.rewards.reconcile(T);
  assert.equal(w.app.gifts.mine(T, 'b1')[0].reward_state!.status, 'confirmed');
  // vencido: lo no reclamado pasa a «vencido» y ya no se puede reclamar
  w.clock.advance(3 * 86_400_000);
  assert.equal(w.app.gifts.tick(), 1);
  assert.equal(w.app.gifts.get(T, 'reg_bono')!.status, 'closed');
  assert.deepEqual(w.app.gifts.mine(T, 'b2').map((g) => g.status), ['expired']);
  assert.throws(() => w.app.gifts.claim(T, 'b2', 'reg_bono'), /no está disponible|venció/);
  // cierre manual con motivo: revoca lo pendiente y avisa
  w.app.gifts.saveDraft(A, gift({ id: 'reg_cierre', audience: { players: ['b3'] }, expires_at: w.exp(2) }) as never);
  w.app.gifts.submit(A, 'reg_cierre'); w.app.gifts.approve(B, 'reg_cierre');
  assert.throws(() => w.app.gifts.close(B, 'reg_cierre', ''), /motivo/);
  w.app.gifts.close(B, 'reg_cierre', 'error en la campaña');
  assert.equal(w.app.gifts.mine(T, 'b3').find((g) => g.gift_id === 'reg_cierre')!.status, 'revoked');
  assert.ok(w.app.realtime.since(T, 'b3', 0).events.some((e) => e.type === 'gift.revoked'));
});

test('Regalos · aislamiento entre tenants', async () => {
  const w = world();
  onboard(w.app, w.clock, 'iso1');
  w.app.gifts.saveDraft({ id: 'ana@ss1', tenant_id: T }, gift({ id: 'reg_iso', audience: { players: ['iso1'] }, expires_at: w.exp() }) as never);
  w.app.gifts.submit({ id: 'ana@ss1', tenant_id: T }, 'reg_iso'); w.app.gifts.approve({ id: 'beto@ss1', tenant_id: T }, 'reg_iso');
  assert.equal((await w.call('GET', '/gifts/reg_iso', 'crm_analyst', {}, T2)).status, 404);
  assert.equal((await w.call('POST', '/players/iso1/gifts/reg_iso/claim', 'support', {}, T2)).status, 404);
  assert.equal(w.app.gifts.list(T2).length, 0);
});

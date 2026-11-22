import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, onboard, ev, T } from './helpers.ts';

test('CRM-06/07: otorgamiento idempotente, notificación única al confirmar el servicio de bonos', () => {
  const { app, clock } = setup();
  onboard(app, clock, 'p'); // verificado ⇒ jx_welcome_bonus otorga free spins (si cae en tratamiento)
  const inst = app.runtime.instances(T, { player_id: 'p', journey_id: 'jx_welcome_bonus' })[0];
  const grants = app.rewards.grants(T).filter((g) => g.player_id === 'p');
  if (inst.arm === 'control') { assert.equal(grants.length, 0); return; }
  assert.equal(grants.length, 1); assert.equal(grants[0].status, 'confirmed');
  // repetir la solicitud no duplica bono ni cargo
  const again = app.rewards.grant({ tenant_id: T, player_id: 'p', reward_id: 'welcome_fs_10', idempotency_key: grants[0].idempotency_key, actor: 't' });
  assert.equal(again.grant_id, grants[0].grant_id);
  assert.equal(app.rewards.budget(T, 'welcome_fs_10')!.committed_minor, 1000_00);
  // reward.granted del servicio de bonos ⇒ aviso (recorrido 3) una sola vez aunque el evento se repita
  const ge = app.ingestor.get(T, 'p')!.timeline.filter((t) => t.event_type === 'reward.granted');
  assert.equal(ge.length, 1);
});

test('CRM-07: presupuesto agotado, resultado incierto conciliado sin duplicar', () => {
  const { app } = setup();
  for (let i = 0; i < 50; i++) app.rewards.grant({ tenant_id: T, player_id: `x${i}`, reward_id: 'welcome_fs_10', idempotency_key: `k${i}`, actor: 't' });
  const over = app.rewards.grant({ tenant_id: T, player_id: 'x50', reward_id: 'welcome_fs_10', idempotency_key: 'k50', actor: 't' });
  assert.equal(over.status, 'failed'); assert.equal(over.reason, 'budget_exhausted');
  const { app: a2 } = setup();
  a2.bonus.timeoutNext = 1;
  const u = a2.rewards.grant({ tenant_id: T, player_id: 'u', reward_id: 'welcome_fs_10', idempotency_key: 'ku', actor: 't' });
  assert.equal(u.status, 'uncertain');
  const retry = a2.rewards.grant({ tenant_id: T, player_id: 'u', reward_id: 'welcome_fs_10', idempotency_key: 'ku', actor: 't' });
  assert.equal(retry.status, 'confirmed'); assert.match(retry.reason!, /^reconciled:/);
  assert.equal(a2.rewards.budget(T, 'welcome_fs_10')!.committed_minor, 1000_00);
  assert.deepEqual(a2.rewards.reconcile(T).missing_in_bonus_service, []);
});

test('CRM-06: 50 % entre umbral actual y siguiente, una vez por nivel y temporada; reverso compensatorio (CRM-10)', () => {
  const { app, clock } = setup();
  onboard(app, clock, 'p', T, { verify: false });
  const bet = (id: string, cop: number) => app.ingestor.ingest(ev(T, 'p', 'bet.settled', { bet_id: id, stake: { amount_minor: cop * 100, currency: 'COP' }, product: 'casino' }, clock.now().toISOString()));
  bet('b1', 400_000); // 400 pts → 40 % hacia Plata (1000)
  assert.equal(app.loyalty.progress(T, 'rumbawin', 'p').percent_to_next, 40);
  bet('b2', 200_000); // 600 pts → 60 %
  bet('b3', 100_000); // 700 pts → sigue sobre 50 %, sin nuevo aviso
  const crossed = app.ingestor.get(T, 'p')!.timeline.filter((t) => t.event_type === 'loyalty.threshold_crossed');
  assert.equal(crossed.length, 1);
  const notices = app.channels.receipts(T, 'p').filter((r) => r.template === 'loyalty_halfway');
  assert.equal(notices.length, 1);
  assert.match(notices[0].rendered!.body, /60 % del camino al nivel Plata/);
  // reverso: asiento compensatorio
  app.loyalty.reverse(T, 'rumbawin', app.ingestor.get(T, 'p')!.timeline.find((t) => t.event_type === 'bet.settled')!.event_id, 'bet voided');
  assert.equal(app.loyalty.progress(T, 'rumbawin', 'p').points, 300);
  assert.equal(app.loyalty.movements(T, 'p').filter((m) => m.compensates).length, 1);
  // Plata: 3000 pts → 0 % de Plata→Oro; 3000+? cruza 50 % de 1000..5000 en 3000
  bet('b4', 2_700_000);
  assert.equal(app.loyalty.progress(T, 'rumbawin', 'p').level, 'Plata');
  assert.equal(app.ingestor.get(T, 'p')!.timeline.filter((t) => t.event_type === 'loyalty.threshold_crossed').length, 2);
});

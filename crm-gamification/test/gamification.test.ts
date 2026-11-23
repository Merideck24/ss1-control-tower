import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, onboard, ev, T } from './helpers.ts';
import { route } from '../src/api/router.ts';
import { DAY } from '../src/shared/util.ts';

const W = { starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-12-31T00:00:00Z' };
const analyst = { id: 'ana', tenant_id: T };
function world() {
  const s = setup('2026-11-15T15:00:00Z');
  const at = (h = 0) => new Date(s.clock.now().getTime() + h * 3_600_000).toISOString();
  const bet = (p: string, id: string, product: 'casino' | 'sports', h = 0) => s.app.ingestor.ingest(ev(T, p, 'bet.settled', { bet_id: id, stake: { amount_minor: 10_000, currency: 'COP' }, product }, at(h)));
  const dep = (p: string, id: string, amt: number, h = 0) => s.app.ingestor.ingest(ev(T, p, 'deposit.settled', { deposit_id: id, amount_minor: amt, currency: 'COP' }, at(h)));
  return { ...s, bet, dep, at };
}
const view = (app: ReturnType<typeof setup>['app'], p: string, id: string) => app.gamification.playerView(T, p).missions.find((m) => m.id === id)!;

test('G2: misión de conteo otorga XP una sola vez; filtro de producto y duplicados', () => {
  const { app, clock, bet } = world();
  onboard(app, clock, 'p', T, { verify: false });
  app.gamification.save(analyst, { id: 'ms_1', brand_id: 'rumbawin', name: 'n', description: 'd', kind: 'count', event_type: 'bet.settled', product: 'sports', target: 3, reward: { xp: 150 }, ...W });
  app.gamification.activate({ ...analyst, canApprove: false }, 'ms_1');
  bet('p', 'c1', 'casino'); bet('p', 's1', 'sports'); bet('p', 's2', 'sports');
  assert.equal(view(app, 'p', 'ms_1').value, 2);
  bet('p', 's3', 'sports'); bet('p', 's4', 'sports');
  const v = view(app, 'p', 'ms_1');
  assert.ok(v.completed_at); assert.equal(v.value, 3); assert.equal(v.reward_status, 'xp_awarded');
  assert.equal(app.loyalty.movements(T, 'p').filter((m) => m.reason === 'mission:ms_1').length, 1);
});

test('G2: racha en días de Bogotá y misión de suma con reverso compensatorio', () => {
  const { app, clock, dep } = world();
  onboard(app, clock, 'p', T, { verify: false });
  app.gamification.save(analyst, { id: 'streak', brand_id: 'rumbawin', name: 'n', description: 'd', kind: 'streak', event_type: 'deposit.settled', target: 3, reward: { xp: 10 }, ...W });
  app.gamification.save(analyst, { id: 'sum', brand_id: 'rumbawin', name: 'n', description: 'd', kind: 'sum', event_type: 'deposit.settled', target: 300_000, reward: { xp: 10 }, ...W });
  for (const id of ['streak', 'sum']) app.gamification.activate({ ...analyst, canApprove: false }, id);
  dep('p', 'd1', 100_000, 0); dep('p', 'd2', 100_000, 24);
  assert.equal(view(app, 'p', 'streak').value, 2);
  app.ingestor.ingest(ev(T, 'p', 'deposit.reversed', { deposit_id: 'd2', amount_minor: 100_000, currency: 'COP' }, new Date(clock.now().getTime() + 25 * 3_600_000).toISOString()));
  assert.equal(view(app, 'p', 'sum').value, 100_000, 'reverso descuenta lo contado');
  dep('p', 'd3', 250_000, 48);
  assert.ok(view(app, 'p', 'sum').completed_at);
  assert.ok(view(app, 'p', 'streak').completed_at, '3 días seguidos (00:00 Bogotá)');
  app.ingestor.ingest(ev(T, 'p', 'deposit.reversed', { deposit_id: 'd3', amount_minor: 250_000, currency: 'COP' }, new Date(clock.now().getTime() + 49 * 3_600_000).toISOString()));
  assert.equal(view(app, 'p', 'sum').disputed, true);
  assert.equal(app.audit.list(T, { action: 'mission.completion_disputed' }).length >= 1, true);
});

test('G2/G10: desactivación, juego responsable, segmento y ventana bloquean el progreso', () => {
  const { app, clock, bet } = world();
  for (const p of ['out', 'rg', 'ok', 'nok']) onboard(app, clock, p, T, { verify: p !== 'nok' });
  app.gamification.save(analyst, { id: 'seg_m', brand_id: 'rumbawin', name: 'n', description: 'd', kind: 'count', event_type: 'bet.settled', target: 1, reward: { xp: 5 }, segment: { field: 'kyc', op: 'eq', value: 'verified' }, ...W });
  app.gamification.save(analyst, { id: 'old', brand_id: 'rumbawin', name: 'n', description: 'd', kind: 'count', event_type: 'bet.settled', target: 1, reward: { xp: 5 }, starts_at: '2026-01-01T00:00:00Z', ends_at: '2026-02-01T00:00:00Z' });
  for (const id of ['seg_m', 'old']) app.gamification.activate({ ...analyst, canApprove: false }, id);
  app.loyalty.setOptOut(T, 'out', true);
  app.ingestor.ingest(ev(T, 'rg', 'rg.status_changed', { status: 'self_excluded' }, clock.now().toISOString()));
  for (const p of ['out', 'rg', 'ok', 'nok']) bet(p, `b-${p}`, 'casino');
  const done = (p: string, id: string) => !!app.gamification.playerView(T, p).missions.find((m) => m.id === id)?.completed_at;
  assert.deepEqual(['out', 'rg', 'ok', 'nok'].map((p) => done(p, 'seg_m')), [false, false, true, false]);
  assert.equal(done('ok', 'old'), false);
});

test('G2: misión con bono requiere aprobación de otra persona y pasa por política', () => {
  const { app, clock, bet } = world();
  onboard(app, clock, 'p');
  app.gamification.save(analyst, { id: 'mb_bonus', brand_id: 'rumbawin', name: 'n', description: 'd', kind: 'count', event_type: 'bet.settled', target: 1, reward: { reward_id: 'welcome_fs_10' }, ...W });
  assert.equal(app.gamification.activate({ ...analyst, canApprove: false }, 'mb_bonus').status, 'pending_approval');
  assert.throws(() => app.gamification.activate({ ...analyst, canApprove: true }, 'mb_bonus'), /autor no puede aprobar/);
  assert.equal(app.gamification.activate({ id: 'boss', tenant_id: T, canApprove: true }, 'mb_bonus').status, 'active');
  bet('p', 'x', 'casino');
  assert.equal(view(app, 'p', 'mb_bonus').reward_status, 'confirmed');
  assert.equal(app.rewards.grants(T).filter((g) => g.idempotency_key === 'mission:mb_bonus:p').length, 1);
  assert.throws(() => app.gamification.save(analyst, { id: 'bad', brand_id: 'rumbawin', name: 'n', description: 'd', kind: 'count', event_type: 'bet.settled', target: 1, reward: {}, ...W }), /recompensa/);
});

test('G3/G10: logros y preferencia por API con permisos y auditoría', async () => {
  const { app, clock, dep } = world();
  onboard(app, clock, 'p', T, { verify: false });
  dep('p', 'd1', 10_000);
  assert.ok(app.gamification.playerView(T, 'p').badges.some((b) => b.id === 'first_deposit'));
  const call = (roles: string, body: Record<string, unknown>) => route(app, { method: 'POST', path: '/players/p/gamification-preference', query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': roles }, body });
  assert.equal((await call('crm_analyst', { opt_out: true })).status, 403);
  assert.equal((await call('support', { opt_out: true })).status, 200);
  assert.equal(app.gamification.playerView(T, 'p').opt_out, true);
  assert.equal(app.audit.list(T, { action: 'player.gamification_preference' }).length, 1);
  const list = await route(app, { method: 'GET', path: '/gamification/missions', query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': 'auditor' }, body: {} });
  assert.equal(list.status, 200);
  void DAY;
});

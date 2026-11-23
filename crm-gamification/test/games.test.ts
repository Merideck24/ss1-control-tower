import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, onboard, ev, T } from './helpers.ts';
import { outcomeFor, rankTournament, standingsHash } from '../src/gamification/games.ts';
import { sha256 } from '../src/shared/util.ts';
import { route } from '../src/api/router.ts';

test('G4: ranking reproducible en cualquier orden, sin duplicados, con desempate determinista', () => {
  const evs = [
    { player_id: 'a', event_id: 'e1', at: '2026-11-10T10:00:00Z', points: 5 },
    { player_id: 'b', event_id: 'e2', at: '2026-11-10T09:00:00Z', points: 5 },
    { player_id: 'c', event_id: 'e3', at: '2026-11-10T11:00:00Z', points: 2 },
    { player_id: 'a', event_id: 'e1', at: '2026-11-10T10:00:00Z', points: 5 },
    { player_id: 'c', event_id: 'e4', at: '2026-11-10T08:00:00Z', points: 1 },
  ];
  const a = rankTournament(evs, 2);
  const b = rankTournament([...evs].reverse(), 2);
  assert.deepEqual(a, b);
  assert.equal(standingsHash(a), standingsHash(b));
  assert.deepEqual(a.map((s) => [s.rank, s.player_id, s.score]), [[1, 'b', 5], [2, 'a', 5], [3, 'c', 3]], 'b llegó a 5 antes que a; duplicado e1 ignorado');
  assert.equal(rankTournament(evs, 4).length, 2);
});

function tworld() {
  const { app, clock } = setup('2026-11-15T15:00:00Z');
  for (const p of ['p1', 'p2', 'p3']) onboard(app, clock, p);
  const actor = { id: 'ana', tenant_id: T };
  app.games.saveTournament(actor, { id: 't_test', brand_id: 'rumbawin', name: 'T', metric: 'stake_capped', stake_cap_minor: 50_000, product: 'sports', starts_at: '2026-11-15T00:00:00Z', ends_at: '2026-11-16T00:00:00Z', min_score: 1, prizes: [{ from: 1, to: 1, prize: { xp: 1000 } }, { from: 2, to: 2, prize: { xp: 100 } }] });
  app.games.activateTournament({ ...actor, canApprove: false }, 't_test');
  const bet = (p: string, id: string, stake: number, product: 'sports' | 'casino' = 'sports') => app.ingestor.ingest(ev(T, p, 'bet.settled', { bet_id: id, stake: { amount_minor: stake, currency: 'COP' }, product }, clock.now().toISOString()));
  return { app, clock, actor, bet };
}

test('G4: puntaje con tope por apuesta, cierre con hash, exclusión JR al cierre e idempotencia de premios', () => {
  const { app, clock, actor, bet } = tworld();
  bet('p1', 'a', 1_000_000); bet('p2', 'b', 40_000); bet('p2', 'c', 30_000); bet('p3', 'd', 45_000); bet('p1', 'casino', 999_999, 'casino');
  assert.deepEqual(app.games.standings(T, 't_test').map((s) => [s.player_id, s.score]), [['p2', 70_000], ['p1', 50_000], ['p3', 45_000]]);
  assert.throws(() => app.games.finalizeTournament(actor, 't_test'), /aún no termina/);
  app.ingestor.ingest(ev(T, 'p2', 'rg.status_changed', { status: 'self_excluded' }, clock.now().toISOString()));
  clock.set('2026-11-16T01:00:00Z');
  const t = app.games.finalizeTournament(actor, 't_test');
  assert.deepEqual(t.final!.standings.map((s) => [s.rank, s.player_id]), [[1, 'p1'], [2, 'p3']]);
  assert.equal(t.final!.excluded, 1);
  assert.equal(t.final!.hash, standingsHash(t.final!.standings));
  const again = app.games.finalizeTournament(actor, 't_test');
  assert.equal(again.final!.hash, t.final!.hash);
  assert.equal(app.loyalty.movements(T, 'p1').filter((m) => m.reason === 'tournament:t_test').length, 1);
});

test('G4: torneo con bono requiere aprobación de otra persona', () => {
  const { app } = setup();
  const actor = { id: 'ana', tenant_id: T };
  app.games.saveTournament(actor, { id: 't_bonus', brand_id: 'rumbawin', name: 'T', metric: 'bet_count', starts_at: '2026-11-15T00:00:00Z', ends_at: '2026-11-16T00:00:00Z', min_score: 1, prizes: [{ from: 1, to: 1, prize: { reward_id: 'welcome_fs_10' } }] });
  assert.equal(app.games.activateTournament({ ...actor, canApprove: true }, 't_bonus').status, 'pending_approval');
  assert.throws(() => app.games.activateTournament({ ...actor, canApprove: true }, 't_bonus'), /autor no puede aprobar/);
  assert.equal(app.games.activateTournament({ id: 'boss', tenant_id: T, canApprove: true }, 't_bonus').status, 'active');
});

test('G5: probabilidades respetadas, verificación con semilla revelada, límites e idempotencia', () => {
  const prizes = [{ id: 'none', label: 'n', weight: 60, prize: {} }, { id: 'a', label: 'a', weight: 30, prize: { xp: 10 } }, { id: 'b', label: 'b', weight: 10, prize: { xp: 50 } }];
  const counts: Record<string, number> = { none: 0, a: 0, b: 0 };
  for (let i = 0; i < 20_000; i++) counts[outcomeFor('seed-x', 'p', i, prizes).id]++;
  assert.ok(Math.abs(counts.none / 20_000 - 0.6) < 0.015 && Math.abs(counts.a / 20_000 - 0.3) < 0.015 && Math.abs(counts.b / 20_000 - 0.1) < 0.01, JSON.stringify(counts));
  const { app, clock } = setup('2026-11-15T15:00:00Z');
  onboard(app, clock, 'p'); onboard(app, clock, 'rg');
  app.ingestor.ingest(ev(T, 'rg', 'rg.status_changed', { status: 'cooling_off' }, clock.now().toISOString()));
  const actor = { id: 'ana', tenant_id: T };
  assert.throws(() => app.games.saveGame(actor, { id: 'g_bad', brand_id: 'rumbawin', name: 'g', kind: 'wheel', spins_per_day: 1, prizes: [{ id: 'x', label: 'x', weight: 1, prize: { xp: 1 } }] }), /sin premio/);
  app.games.saveGame(actor, { id: 'g_w', brand_id: 'rumbawin', name: 'g', kind: 'wheel', spins_per_day: 2, prizes });
  const s1 = app.games.spin(T, 'g_w', 'p', 'r1');
  assert.equal(app.games.spin(T, 'g_w', 'p', 'r1'), s1, 'misma solicitud ⇒ misma tirada');
  app.games.spin(T, 'g_w', 'p', 'r2');
  assert.throws(() => app.games.spin(T, 'g_w', 'p', 'r3'), /sin tiradas/);
  assert.throws(() => app.games.spin(T, 'g_w', 'rg', 'r4'), /juego responsable/);
  const commit = app.games.seeds(T, 'g_w')[0].commit;
  assert.equal(app.games.seeds(T, 'g_w')[0].seed, null, 'la semilla vigente no se revela');
  const seeds = app.games.rotateSeed(actor, 'g_w');
  const revealed = seeds[0].seed!;
  assert.equal(sha256(revealed), commit);
  assert.equal(outcomeFor(revealed, 'p', s1.nonce, prizes).id, s1.outcome, 'cualquiera puede verificar el resultado');
  clock.advance(24 * 3_600_000);
  assert.equal(app.games.spinsLeft(T, 'g_w', 'p'), 2, 'las tiradas se renuevan al día siguiente (hora de Bogotá)');
});

test('G4/G5: API con permisos y verificación pública', async () => {
  const { app, clock } = setup('2026-11-15T15:00:00Z');
  onboard(app, clock, 'p');
  app.games.saveGame({ id: 'ana', tenant_id: T }, { id: 'g_api', brand_id: 'rumbawin', name: 'g', kind: 'box', spins_per_day: 1, prizes: [{ id: 'none', label: 'n', weight: 1, prize: {} }, { id: 'x', label: 'x', weight: 1, prize: { xp: 5 } }] });
  const call = (method: string, path: string, roles: string, body: Record<string, unknown> = {}, q = '') => route(app, { method, path, query: new URLSearchParams(q), headers: { 'x-tenant-id': T, 'x-roles': roles }, body });
  assert.equal((await call('POST', '/gamification/minigames/g_api/spin', 'crm_analyst', { player_id: 'p', request_id: 'x1' })).status, 403);
  const s = (await call('POST', '/gamification/minigames/g_api/spin', 'support', { player_id: 'p', request_id: 'x1' })).body as { nonce: number; outcome: string };
  assert.equal((await call('POST', '/gamification/minigames/g_api/rotate-seed', 'support')).status, 403);
  const seeds = (await call('POST', '/gamification/minigames/g_api/rotate-seed', 'tenant_admin')).body as { seed: string | null }[];
  const v = (await call('GET', '/gamification/minigames/g_api/verify', 'support', {}, `seed=${seeds[0].seed}&player=p&nonce=${s.nonce}`)).body as { outcome: string };
  assert.equal(v.outcome, s.outcome);
  const list = (await call('GET', '/gamification/minigames', 'auditor')).body as { spins: number; expected: { probabilities: unknown[] } }[];
  assert.equal(list[0].spins, 1);
});

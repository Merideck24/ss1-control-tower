/**
 * Torneos ampliados y clasificaciones: reglas fijadas al iniciar, inscripción voluntaria, eventos tardíos
 * con margen, cierre con conciliación sin pagar, aprobación de resultados por otra persona, reconstrucción
 * desde los eventos; tablas con empates y desempates visibles, paginación, alias con permiso, ocultarse,
 * juego responsable y visibilidad por tabla.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/api/router.ts';
import { setup, onboard, ev, T } from './helpers.ts';

type R = { status: number; body: any };
function world(at = '2026-11-15T15:00:00Z') {
  const { app, clock } = setup(at);
  const call = (method: string, path: string, roles: string, body: Record<string, unknown> = {}): Promise<R> =>
    route(app, { method, path: path.split('?')[0], query: new URLSearchParams(path.split('?')[1] ?? ''), headers: { 'x-tenant-id': T, 'x-roles': roles, 'x-actor': `${roles}@ss1` }, body }) as Promise<R>;
  const bet = (p: string, id: string, occurred = clock.now().toISOString()) => app.ingestor.ingest(ev(T, p, 'bet.settled', { bet_id: id, stake: { amount_minor: 100_000, currency: 'COP' }, product: 'sports' }, occurred, { event_id: id }));
  return { app, clock, call, bet };
}
const T1 = { id: 't_opt', brand_id: 'rumbawin', name: 'Copa de prueba', metric: 'bet_count', product: 'sports', starts_at: '2026-11-15T00:00:00Z', ends_at: '2026-11-16T00:00:00Z', min_score: 1,
  enrollment: 'opt_in', late_grace_minutes: 30, prizes: [{ from: 1, to: 1, prize: { xp: 500 } }, { from: 2, to: 3, prize: { xp: 100 } }] };

test('Torneos · reglas fijadas, inscripción, eventos tardíos, cierre conciliado y aprobación de resultados antes de pagar', async () => {
  const w = world();
  for (const p of ['a', 'b', 'c', 'x', 'rg']) onboard(w.app, w.clock, p);
  w.app.ingestor.ingest(ev(T, 'rg', 'rg.status_changed', { status: 'self_excluded' }, w.clock.now().toISOString()));
  assert.equal((await w.call('POST', '/gamification/tournaments', 'crm_analyst', T1)).status, 201);
  const act = await w.call('POST', '/gamification/tournaments/t_opt/activate', 'crm_analyst');
  assert.deepEqual([act.status, act.body.status, act.body.version], [200, 'active', 1]);
  assert.match(act.body.rules_hash, /^[0-9a-f]{64}$/);
  // reglas fijadas: cambiarlas exige un torneo nuevo
  const edit = await w.call('POST', '/gamification/tournaments', 'crm_analyst', { ...T1, min_score: 5 });
  assert.equal(edit.status, 422); assert.match(edit.body.message, /reglas se fijaron al iniciar/);
  // inscripción voluntaria; juego responsable
  for (const p of ['a', 'b', 'c']) assert.equal((await w.call('POST', `/players/${p}/tournaments/t_opt/enroll`, 'support')).status, 200);
  assert.equal((await w.call('POST', '/players/rg/tournaments/t_opt/enroll', 'support')).status, 422);
  w.bet('x', 'x1'); // sin inscripción: no cuenta
  w.bet('a', 'a1'); w.bet('a', 'a2'); w.bet('b', 'b1'); w.clock.advance(60_000); w.bet('b', 'b2'); w.bet('c', 'c1');
  w.bet('a', 'a1'); // duplicado
  assert.deepEqual(w.app.games.standings(T, 't_opt').map((s) => [s.player_id, s.score]), [['a', 2], ['b', 2], ['c', 1]], 'a llegó a 2 antes que b');
  assert.ok(w.app.realtime.since(T, 'a', 0).events.some((e) => e.type === 'leaderboard.updated'), 'aviso en vivo de la posición');
  // evento tardío: ocurrió dentro de la ventana, llega 20 min después del fin → cuenta; a los 40 min → no
  w.clock.set('2026-11-16T00:20:00Z'); w.bet('c', 'c2', '2026-11-15T23:59:00Z');
  w.clock.set('2026-11-16T00:40:00Z'); w.bet('c', 'c3', '2026-11-15T23:59:30Z');
  const t0 = w.app.games.tournament(T, 't_opt')!;
  assert.deepEqual([t0.late!.accepted, t0.late!.rejected_after_grace], [1, 1]);
  // cierre: conciliación desde los eventos, sin pagar
  const xpA = w.app.loyalty.balance(T, 'a', '2026-Q4');
  const cl = await w.call('POST', '/gamification/tournaments/t_opt/close', 'crm_analyst');
  assert.deepEqual([cl.status, cl.body.status], [200, 'results_pending']);
  assert.deepEqual(cl.body.results.planned.map((p: any) => [p.player_id, p.rank]), [['a', 1], ['b', 2], ['c', 3]]);
  assert.equal(w.app.loyalty.balance(T, 'a', '2026-Q4'), xpA, 'cerrar no paga');
  // un evento después del cierre no altera el resultado
  w.bet('c', 'c4', '2026-11-15T23:59:50Z');
  const rb = await w.call('GET', '/gamification/tournaments/t_opt/rebuild', 'crm_analyst');
  assert.equal(rb.body.hash, cl.body.results.hash, 'la reconstrucción coincide con el cierre');
  assert.equal(w.app.games.tournament(T, 't_opt')!.late!.ignored_after_close, 1);
  // aprobación: otra persona; quien cerró no puede
  assert.equal((await w.call('POST', '/gamification/tournaments/t_opt/approve-results', 'crm_analyst')).status, 403);
  const ap = await w.call('POST', '/gamification/tournaments/t_opt/approve-results', 'approver');
  assert.deepEqual([ap.status, ap.body.status, ap.body.final.payouts.length, ap.body.final.approved_by], [200, 'finished', 3, 'approver@ss1']);
  assert.equal(w.app.loyalty.balance(T, 'a', '2026-Q4') - xpA, 500);
  assert.ok(w.app.realtime.since(T, 'a', 0).events.some((e) => e.type === 'tournament.result'));
  // idempotente
  await w.call('POST', '/gamification/tournaments/t_opt/approve-results', 'approver');
  assert.equal(w.app.loyalty.balance(T, 'a', '2026-Q4') - xpA, 500);
});

test('Clasificaciones · empates visibles, paginación, fila propia, alias con permiso, ocultarse, juego responsable y visibilidad', async () => {
  const w = world();
  const ps = ['p1', 'p2', 'p3', 'p4', 'p5', 'rg1'];
  for (const p of ps) onboard(w.app, w.clock, p);
  w.app.games.saveTournament({ id: 'ana', tenant_id: T }, { ...T1, id: 't_pub', enrollment: 'auto', leaderboard_visibility: 'public' } as never);
  w.app.games.activateTournament({ id: 'ana', tenant_id: T, canApprove: false }, 't_pub');
  const n: Record<string, number> = { p1: 3, p2: 3, p3: 2, p4: 1, p5: 1, rg1: 5 };
  for (const [p, k] of Object.entries(n)) for (let i = 0; i < k; i++) { w.bet(p, `${p}-${i}`); w.clock.advance(1000); }
  w.app.ingestor.ingest(ev(T, 'rg1', 'rg.status_changed', { status: 'self_excluded' }, w.clock.now().toISOString()));
  w.app.achievements.setAlias(T, 'p1', 'Campeon_1', true);
  w.app.achievements.setAlias(T, 'p2', 'Sin_permiso', false);
  w.app.leaderboards.setHidden(T, 'p3', true);
  const b1 = (await w.call('GET', '/players/p5/leaderboards/tournament/t_pub?size=2', 'support')).body;
  assert.equal(b1.total, 5, 'el jugador con restricción no aparece');
  assert.deepEqual(b1.rows.map((r: any) => [r.position, r.display, r.score, r.tied]), [[1, 'Campeon_1', 3, true], [2, b1.rows[1].display, 3, true]]);
  assert.match(b1.rows[1].display, /^Jugador ·[0-9a-f]{4}$/, 'sin permiso: nombre opaco, nunca el id');
  assert.ok(!JSON.stringify(b1).includes('"p2"') && !JSON.stringify(b1).includes('player_id'), 'el sitio no recibe ids');
  assert.match(b1.tie_rule, /primero/);
  assert.deepEqual([b1.pages, b1.viewer_row.position, b1.viewer_row.is_viewer], [3, 5, true], 'fila propia fuera de la página');
  const b2 = (await w.call('GET', '/players/p5/leaderboards/tournament/t_pub?size=2&page=2', 'support')).body;
  assert.deepEqual(b2.rows.map((r: any) => [r.position, r.display]), [[3, 'Jugador oculto'], [4, b2.rows[1].display]], 'oculto: sigue contando');
  // backoffice: con ids
  const bo = (await w.call('GET', '/leaderboards/tournament/t_pub?size=50', 'crm_analyst')).body;
  assert.deepEqual(bo.rows.map((r: any) => r.player_id), ['p1', 'p2', 'p3', 'p4', 'p5']);
  // visibilidad: oculta en el sitio
  w.app.games.saveTournament({ id: 'ana', tenant_id: T }, { ...T1, id: 't_hid', enrollment: 'auto', leaderboard_visibility: 'hidden' } as never);
  w.app.games.activateTournament({ id: 'ana', tenant_id: T, canApprove: false }, 't_hid');
  assert.equal((await w.call('GET', '/players/p1/leaderboards/tournament/t_hid', 'support')).status, 403);
  assert.equal((await w.call('GET', '/leaderboards/tournament/t_hid', 'crm_analyst')).status, 200);
  // lista del jugador: tablas visibles con su posición; temporada desde el libro de XP
  w.app.loyalty.award(T, 'rumbawin', 'p4', 900, 'mission:m', 'mission:m:p4');
  const lst = (await w.call('GET', '/players/p4/leaderboards', 'support')).body.boards;
  assert.ok(lst.some((b: any) => b.type === 'tournament' && b.id === 't_pub' && b.position === 4));
  assert.ok(!lst.some((b: any) => b.id === 't_hid'));
  const season = lst.find((b: any) => b.type === 'season');
  assert.equal(season.position, 1, 'XP de la temporada');
});

test('Clasificaciones · reto: solo participantes la ven', async () => {
  const w = world();
  for (const p of ['c1', 'c2', 'c3']) onboard(w.app, w.clock, p);
  const A = { id: 'ana@ss1', tenant_id: T }, B = { id: 'beto@ss1', tenant_id: T };
  w.app.challenges.saveDraft(A, { id: 'reto_lb', brand_id: 'rumbawin', name: 'Reto LB', description: 'x', period: 'season', season: 'S', mode: 'all', reward: { xp: 10 },
    steps: [{ id: 'v', label: 'Visita', kind: 'activity', action: 'feature_visited', target: 3 }], starts_at: '2026-11-14T00:00:00Z', ends_at: '2026-12-31T00:00:00Z', timezone: 'America/Bogota' } as never);
  w.app.challenges.submit(A, 'reto_lb'); w.app.challenges.approve(B, 'reto_lb');
  w.app.challenges.enroll(T, 'c1', 'reto_lb', false); w.app.challenges.enroll(T, 'c2', 'reto_lb', false);
  for (const [p, k] of [['c1', 2], ['c2', 1]] as const) for (let i = 0; i < k; i++) w.app.ingestor.ingest(ev(T, p, 'player.activity' as never, { action: 'feature_visited', feature: `f${i}` } as never, w.clock.now().toISOString(), { event_id: `${p}-v${i}` }));
  const b = (await w.call('GET', '/players/c2/leaderboards/challenge/reto_lb', 'support')).body;
  assert.deepEqual(b.rows.map((r: any) => r.score), [2, 1]);
  assert.equal(b.viewer_row.position, 2);
  assert.equal((await w.call('GET', '/players/c3/leaderboards/challenge/reto_lb', 'support')).status, 403, 'no participante');
});

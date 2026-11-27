/**
 * Concursos de punta a punta: bases → aprobación (firma y compromiso del sorteo) → participaciones sin
 * compra → revisión con descalificación motivada → cierre → sorteo verificable o jurado con motivación →
 * aprobación de ganadores por otra persona → premios una sola vez. Y los bordes: juego responsable,
 * requisitos, mecanismo de sorteo no autorizado en producción, cancelación, aislamiento.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/api/router.ts';
import { ContestService, demoDrawProvider } from '../src/gamification/contests.ts';
import { setup, onboard, ev, T, T2 } from './helpers.ts';

type R = { status: number; body: any };
function world() {
  const { app, clock } = setup('2026-11-20T15:00:00Z');
  const call = (method: string, path: string, roles: string, body: Record<string, unknown> = {}, tenant = T, actorId = `${roles}@ss1`): Promise<R> =>
    route(app, { method, path, query: new URLSearchParams(), headers: { 'x-tenant-id': tenant, 'x-roles': roles, 'x-actor': actorId }, body }) as Promise<R>;
  return { app, clock, call };
}
const RULES = 'Participa gratis entre el 20 y el 25 de noviembre. Sin compra ni apuesta. Un ganador por puesto elegido por sorteo verificable.';
const base = (o: Record<string, unknown> = {}) => ({ id: 'conc_nov', brand_id: 'rumbawin', name: 'Concurso de noviembre', rules: RULES, kind: 'draw', requirements: {},
  opens_at: '2026-11-20T00:00:00Z', closes_at: '2026-11-25T00:00:00Z', prizes: [{ place: 1, label: 'Camiseta + 500 XP', xp: 500 }, { place: 2, label: '100 monedas', coins: 100 }], ...o });

test('Concursos · sorteo: bases firmadas, participaciones, descalificación motivada, sorteo verificable, aprobación de ganadores y premios una vez', async () => {
  const w = world();
  const ps = ['k1', 'k2', 'k3', 'k4', 'k5', 'krg'];
  for (const p of ps) onboard(w.app, w.clock, p);
  assert.equal((await w.call('POST', '/contests', 'crm_analyst', base())).status, 201);
  assert.equal((await w.call('POST', '/contests/conc_nov/submit', 'crm_analyst')).status, 200);
  assert.equal((await w.call('POST', '/contests/conc_nov/approve', 'crm_analyst')).status, 403);
  const ap = await w.call('POST', '/contests/conc_nov/approve', 'approver');
  assert.deepEqual([ap.status, ap.body.status], [200, 'open']);
  assert.match(ap.body.rules_signature, /^[0-9a-f]{64}$/);
  assert.match(ap.body.draw.seed_commit, /^[0-9a-f]{64}$/);
  assert.equal(ap.body.draw.seed, undefined, 'la semilla no se publica antes del sorteo');
  assert.ok(!JSON.stringify((await w.call('GET', '/contests/conc_nov', 'crm_analyst')).body).includes('"seed":'), 'ni en el detalle');
  // participar exige aceptar las bases; una vez por jugador; juego responsable
  assert.equal((await w.call('POST', '/players/k1/contests/conc_nov/enter', 'support', {})).status, 422);
  for (const p of ['k1', 'k2', 'k3', 'k4', 'k5']) assert.equal((await w.call('POST', `/players/${p}/contests/conc_nov/enter`, 'support', { accept_rules: true })).status, 200);
  await w.call('POST', '/players/k1/contests/conc_nov/enter', 'support', { accept_rules: true });
  w.app.ingestor.ingest(ev(T, 'krg', 'rg.status_changed', { status: 'self_excluded' }, w.clock.now().toISOString()));
  assert.equal((await w.call('POST', '/players/krg/contests/conc_nov/enter', 'support', { accept_rules: true })).status, 422);
  assert.equal(w.app.contests.entries(T, 'conc_nov').length, 5);
  // revisión: descalificar exige código y motivo; se puede revertir con motivo
  assert.equal((await w.call('POST', '/contests/conc_nov/entries/k5/disqualify', 'crm_analyst', { code: 'duplicate_account', reason: 'corto' })).status, 422);
  assert.equal((await w.call('POST', '/contests/conc_nov/entries/k5/disqualify', 'crm_analyst', { code: 'duplicate_account', reason: 'Misma persona que k4 según el PAM' })).status, 200);
  assert.equal((await w.call('POST', '/contests/conc_nov/entries/k4/disqualify', 'crm_analyst', { code: 'rules_breach', reason: 'Revisión preliminar equivocada' })).status, 200);
  assert.equal((await w.call('POST', '/contests/conc_nov/entries/k4/reinstate', 'crm_analyst', { reason: 'La revisión confirmó que cumple las bases' })).status, 200);
  // una señal de riesgo después de participar lo saca del sorteo
  w.app.ingestor.ingest(ev(T, 'k3', 'rg.risk_signal', { level: 'high', score: 0.9, signals: ['chasing'] }, w.clock.now().toISOString()));
  // sortear exige cerrar
  assert.equal((await w.call('POST', '/contests/conc_nov/draw', 'crm_analyst')).status, 422);
  assert.equal((await w.call('POST', '/contests/conc_nov/close', 'crm_analyst')).status, 200);
  assert.equal((await w.call('POST', '/players/k5/contests/conc_nov/enter', 'support', { accept_rules: true })).body.status, 'disqualified', 'repetir no reinscribe');
  const dr = await w.call('POST', '/contests/conc_nov/draw', 'crm_analyst');
  assert.deepEqual([dr.status, dr.body.status, dr.body.winners.length], [200, 'winners_pending', 2]);
  const winners = dr.body.winners.map((x: any) => x.player_id);
  assert.ok(winners.every((p: string) => ['k1', 'k2', 'k4'].includes(p)), `ni descalificados ni con señal: ${winners}`);
  // verificación independiente
  const pr = (await w.call('GET', '/contests/conc_nov/draw-proof', 'auditor')).body;
  assert.deepEqual([pr.commit_matches, pr.reproduced, pr.authorized, pr.entries], [true, true, false, 3]);
  // aprobación de ganadores: otra persona; quien sorteó no
  assert.equal((await w.call('POST', '/contests/conc_nov/approve-winners', 'crm_analyst,approver', {}, T, 'crm_analyst@ss1')).status, 403, 'quien sorteó no aprueba');
  const xp0 = w.app.loyalty.balance(T, winners[0], '2026-Q4'), c0 = w.app.store.balance(T, winners[1]);
  const aw = await w.call('POST', '/contests/conc_nov/approve-winners', 'approver');
  assert.deepEqual([aw.status, aw.body.status, aw.body.payouts.length], [200, 'finished', 2]);
  assert.equal(w.app.loyalty.balance(T, winners[0], '2026-Q4') - xp0, 500);
  assert.equal(w.app.store.balance(T, winners[1]) - c0, 100);
  await w.call('POST', '/contests/conc_nov/approve-winners', 'approver');
  assert.equal(w.app.loyalty.balance(T, winners[0], '2026-Q4') - xp0, 500, 'una sola vez');
  assert.ok(w.app.realtime.since(T, winners[0], 0).events.some((e) => e.type === 'contest.result'));
  // el jugador ve el resultado con nombres públicos, nunca ids
  const view = (await w.call('GET', '/players/k1/contests', 'support')).body.find((c: any) => c.id === 'conc_nov');
  assert.equal(view.result.winners.length, 2);
  assert.ok(!JSON.stringify(view.result).match(/"k\d"/), 'sin ids de otros jugadores');
  for (const a of ['contest.approved', 'contest.entry_disqualified', 'contest.entry_reinstated', 'contest.drawn', 'contest.winners_approved']) assert.ok(w.app.audit.list(T).some((x) => x.action === a), a);
});

test('Concursos · jurado con motivación, requisitos sin compra, validaciones y cancelación', async () => {
  const w = world();
  const A = { id: 'ana@ss1', tenant_id: T }, B = { id: 'beto@ss1', tenant_id: T };
  for (const p of ['j1', 'j2', 'j3']) onboard(w.app, w.clock, p);
  assert.throws(() => w.app.contests.saveDraft(A, base({ id: 'mal1', requirements: { deposit_min: 1000 } }) as never), /no puede exigir depósitos/);
  assert.throws(() => w.app.contests.saveDraft(A, base({ id: 'mal2', rules: 'Corto' }) as never), /bases/);
  assert.throws(() => w.app.contests.saveDraft(A, base({ id: 'mal3', name: 'Recupera tus pérdidas', rules: RULES }) as never), /recuperar pérdidas/);
  w.app.contests.saveDraft(A, base({ id: 'conc_foto', kind: 'judged', question: 'Cuéntanos tu mejor jugada del mes', requirements: { profile_completed: true }, prizes: [{ place: 1, label: '300 XP', xp: 300 }] }) as never);
  w.app.contests.submit(A, 'conc_foto'); w.app.contests.approve(B, 'conc_foto');
  // requisito de perfil completo
  assert.throws(() => w.app.contests.enter(T, 'j1', 'conc_foto', { accept_rules: true, answer: 'Un gol al final' }), /profile_incomplete/);
  for (const p of ['j1', 'j2']) w.app.ingestor.ingest(ev(T, p, 'player.activity' as never, { action: 'profile_completed' } as never, w.clock.now().toISOString(), { event_id: `${p}-pc` }));
  assert.throws(() => w.app.contests.enter(T, 'j1', 'conc_foto', { accept_rules: true }), /respuesta/);
  w.app.contests.enter(T, 'j1', 'conc_foto', { accept_rules: true, answer: 'Un gol al final del partido' });
  w.app.contests.enter(T, 'j2', 'conc_foto', { accept_rules: true, answer: 'Tres aciertos seguidos' });
  w.app.contests.close(A, 'conc_foto');
  assert.throws(() => w.app.contests.drawWinners(A, 'conc_foto'), /jurado/);
  assert.throws(() => w.app.contests.selectWinners(A, 'conc_foto', [{ player_id: 'j3', motivation: 'No participó en el concurso' }]), /participación válida/);
  assert.throws(() => w.app.contests.selectWinners(A, 'conc_foto', [{ player_id: 'j2', motivation: 'ok' }]), /Motiva/);
  w.app.contests.selectWinners(A, 'conc_foto', [{ player_id: 'j2', motivation: 'La respuesta más original según el jurado' }]);
  assert.throws(() => w.app.contests.approveWinners(A, 'conc_foto'), /no los aprueba/);
  const xp0 = w.app.loyalty.balance(T, 'j2', '2026-Q4');
  w.app.contests.approveWinners(B, 'conc_foto');
  assert.equal(w.app.loyalty.balance(T, 'j2', '2026-Q4') - xp0, 300);
  // cancelación con motivo
  w.app.contests.saveDraft(A, base({ id: 'conc_cancel' }) as never); w.app.contests.submit(A, 'conc_cancel'); w.app.contests.approve(B, 'conc_cancel');
  assert.throws(() => w.app.contests.cancel(A, 'conc_cancel', 'no'), /motivo/);
  assert.equal(w.app.contests.cancel(A, 'conc_cancel', 'Error en las bases publicadas').status, 'cancelled');
  // cierre automático por fecha
  w.app.contests.saveDraft(A, base({ id: 'conc_auto' }) as never); w.app.contests.submit(A, 'conc_auto'); w.app.contests.approve(B, 'conc_auto');
  w.clock.set('2026-11-26T00:00:00Z');
  assert.ok(w.app.contests.tick() >= 1);
  assert.equal(w.app.contests.get(T, 'conc_auto')!.status, 'closed');
});

test('Concursos · en producción no se aprueban ganadores de un sorteo no autorizado; con mecanismo autorizado sí', () => {
  const { app, clock } = setup('2026-11-20T15:00:00Z');
  const A = { id: 'ana@ss1', tenant_id: T }, B = { id: 'beto@ss1', tenant_id: T };
  for (const p of ['z1', 'z2']) onboard(app, clock, p);
  const mk = (draw?: typeof demoDrawProvider) => new ContestService({ clock, audit: app.audit, loyalty: app.loyalty, rewards: app.rewards, store: app.store, policy: app.policy, realtime: app.realtime, achievements: app.achievements, profile: (t, p) => app.ingestor.get(t, p), draw, allowUnauthorizedDraw: false });
  const run = (svc: ContestService) => {
    svc.saveDraft(A, base({ prizes: [{ place: 1, label: '50 XP', xp: 50 }] }) as never); svc.submit(A, 'conc_nov'); svc.approve(B, 'conc_nov');
    for (const p of ['z1', 'z2']) svc.enter(T, p, 'conc_nov', { accept_rules: true });
    svc.close(A, 'conc_nov'); svc.drawWinners(A, 'conc_nov');
    return () => svc.approveWinners(B, 'conc_nov');
  };
  assert.throws(run(mk()), /no es un mecanismo autorizado/);
  const certified = { ...demoDrawProvider, name: 'notario-sorteos', authorized: true };
  assert.equal(run(mk(certified))().status, 'finished');
});

test('Concursos · aislamiento entre tenants', async () => {
  const w = world();
  w.app.contests.saveDraft({ id: 'ana@ss1', tenant_id: T }, base() as never);
  assert.equal((await w.call('GET', '/contests/conc_nov', 'crm_analyst', {}, T2)).status, 404);
  assert.equal(w.app.contests.list(T2).length, 0);
});

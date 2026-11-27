/**
 * Impacto de los retos: grupo de control estable (no ve el reto ni puede inscribirse), exposición por
 * intención de tratar, retención D7/D30 con jugadores maduros, incremento con IC 95 % y cohortes de
 * participantes por semana de inscripción.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/api/router.ts';
import { retention } from '../src/analytics/gamImpact.ts';
import { setup, onboard, ev, T } from './helpers.ts';

const DAY = 86_400_000;

test('Impacto · retención D7/D30 con jugadores maduros (ventana de 7 días)', () => {
  const now = Date.parse('2026-12-31T00:00:00Z');
  const entries = [{ player_id: 'a', at: '2026-12-01T00:00:00Z' }, { player_id: 'b', at: '2026-12-01T00:00:00Z' }, { player_id: 'young', at: '2026-12-28T00:00:00Z' }];
  const act: Record<string, number[]> = { a: [Date.parse('2026-12-09T00:00:00Z')], b: [Date.parse('2026-12-03T00:00:00Z'), Date.parse('2026-12-20T00:00:00Z')] };
  const r7 = retention(entries, (p) => act[p] ?? [], now, 7);
  assert.deepEqual(r7, { mature: 2, retained: 1, rate: 0.5 }, 'a volvió el día 8; b el día 2 (no cuenta) y el 19 (fuera de la ventana); young aún no madura');
  assert.deepEqual(retention(entries, (p) => act[p] ?? [], now, 30), { mature: 0, retained: 0, rate: null });
});

test('Impacto · grupo de control: no ve el reto, no se inscribe; incremento D7 tratamiento − control con IC 95 % y cohortes', async () => {
  const { app, clock } = setup('2026-11-01T15:00:00Z');
  const call = (path: string, roles = 'crm_analyst') => route(app, { method: 'GET', path, query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': roles, 'x-actor': `${roles}@ss1` }, body: {} }) as Promise<{ status: number; body: any }>;
  const A = { id: 'ana@ss1', tenant_id: T }, B = { id: 'beto@ss1', tenant_id: T };
  const ch = { id: 'reto_ctrl', brand_id: 'rumbawin', name: 'Reto con control', description: 'Visita secciones', period: 'season', season: 'S', mode: 'single', reward: { xp: 10 }, control_group_pct: 50,
    steps: [{ id: 'v', label: 'Visita 20 secciones', kind: 'activity', action: 'feature_visited', target: 20 }], starts_at: '2026-10-31T00:00:00Z', ends_at: '2027-01-31T00:00:00Z', timezone: 'America/Bogota' };
  assert.throws(() => app.challenges.saveDraft(A, { ...ch, id: 'reto_mal', control_group_pct: 80 } as never), /entre 0 y 50/);
  app.challenges.saveDraft(A, ch as never); app.challenges.submit(A, 'reto_ctrl'); app.challenges.approve(B, 'reto_ctrl');
  const c = app.challenges.get(T, 'reto_ctrl')!;
  const players = Array.from({ length: 240 }, (_, i) => `imp${String(i).padStart(3, '0')}`);
  for (const p of players) onboard(app, clock, p);
  let n = 0;
  const act = (p: string, at: string) => app.ingestor.ingest(ev(T, p, 'player.activity' as never, { action: 'feature_visited', feature: `s${n}` } as never, at, { event_id: `imp-${n++}` }));
  // exposición: cada jugador genera actividad el día 0
  const t0 = clock.now().toISOString();
  for (const p of players) act(p, t0);
  const arms = players.map((p) => [p, app.challenges.arm(c, p)] as const);
  const ctrl = arms.filter(([, a]) => a === 'control').map(([p]) => p), treat = arms.filter(([, a]) => a === 'treatment').map(([p]) => p);
  assert.ok(ctrl.length > 80 && treat.length > 80, `grupos ~50 %: ${treat.length}/${ctrl.length}`);
  // el control no ve el reto y no puede inscribirse
  assert.ok(!app.challenges.playerView(T, ctrl[0]).some((x) => x.id === 'reto_ctrl'));
  assert.throws(() => app.challenges.enroll(T, ctrl[0], 'reto_ctrl', false), /control_group/);
  // el tratamiento sí; algunos se inscriben (cohorte de participantes)
  assert.ok(app.challenges.playerView(T, treat[0]).some((x) => x.id === 'reto_ctrl'));
  for (const p of treat.slice(0, 40)) app.challenges.enroll(T, p, 'reto_ctrl', false);
  // vuelven el día 8: 60 % del tratamiento y 30 % del control
  clock.advance(8 * DAY);
  const t8 = clock.now().toISOString();
  treat.forEach((p, i) => { if (i % 10 < 6) act(p, t8); });
  ctrl.forEach((p, i) => { if (i % 10 < 3) act(p, t8); });
  // a los 10 días todavía no hay jugadores maduros para D7 (hace falta día 14)
  clock.advance(2 * DAY);
  let r = (await call('/challenges/reto_ctrl/impact')).body;
  assert.equal(r.d7.treatment.mature, 0);
  clock.advance(30 * DAY);
  r = (await call('/challenges/reto_ctrl/impact')).body;
  assert.deepEqual([r.exposed.treatment, r.exposed.control], [treat.length, ctrl.length], 'exposición por intención de tratar');
  assert.equal(r.d7.treatment.mature, treat.length);
  assert.ok(Math.abs(r.d7.treatment.rate - 0.6) < 0.03 && Math.abs(r.d7.control.rate - 0.3) < 0.03, `${r.d7.treatment.rate} / ${r.d7.control.rate}`);
  assert.ok(r.d7.diff > 0.2 && r.d7.ci95[0] > 0, 'incremento positivo y significativo');
  assert.equal(r.d7.reliable, true);
  assert.equal(r.d30.treatment.retained, 0, 'nadie volvió entre el día 30 y el 37');
  assert.deepEqual(r.cohorts.map((x: any) => [x.week, x.n]), [['2026-W44', 40]]);
  assert.equal(r.participants.d7.mature, 40);
  assert.ok(r.definitions.retention && r.definitions.lift);
  assert.equal((await call('/challenges/reto_ctrl/impact', 'support')).status, 403);
});

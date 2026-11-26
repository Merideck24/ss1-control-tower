/**
 * Ciclo completo del Constructor, por la API y con roles separados:
 * borrador → simulación → revisión → envío → aprobación → publicación → ejecución → seguimiento
 * → pausa → reanudación → versión nueva (versión fijada) → cierre.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/api/router.ts';
import { setup, onboard, ev, T } from './helpers.ts';
import { HOUR } from '../src/shared/util.ts';

type R = { status: number; body: any };

test('Constructor: ciclo completo con segregación de funciones, versión fijada, seguimiento y cierre', async () => {
  const { app, clock } = setup();
  const call = (method: string, path: string, roles: string, actor: string, body: Record<string, unknown> = {}): Promise<R> =>
    route(app, { method, path, query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': roles, 'x-actor': actor }, body }) as Promise<R>;
  const ANA = ['crm_analyst', 'ana@ss1'] as const, BETO = ['approver', 'beto@ss1'] as const, ADMIN = ['tenant_admin', 'admin@ss1'] as const;
  const def = (nodes: unknown[]) => ({ id: 'j_qa', brand_id: 'rumbawin', name: 'QA depósito', purpose: 'marketing', trigger: { event_type: 'deposit.settled' }, entry: 'w', nodes });
  const v1 = [{ id: 'w', type: 'wait', duration_ms: 2 * HOUR, next: 'm' }, { id: 'm', type: 'message', channel: 'inapp', template: 'deposit_progress', next: 'e' }, { id: 'e', type: 'exit' }];

  onboard(app, clock, 'p1', T, { verify: false });
  onboard(app, clock, 'p2', T, { verify: false });

  // 1. borrador + revisión en vivo
  assert.ok((await call('POST', '/journeys', ...ANA, def(v1))).status < 300);
  const review = await call('POST', '/journeys/review', ...ANA, def(v1));
  assert.equal(review.status, 200, JSON.stringify(review.body).slice(0, 200));
  // 2. simulación sin efectos
  const sim = await call('POST', '/journeys/j_qa/simulate', ...ANA, { player_id: 'p1' });
  assert.equal(sim.status, 200);
  assert.equal(app.adapters.inapp.list(T, 'p1').items.length, 0, 'la simulación no envía nada');
  // 3. no se puede publicar sin aprobación, ni aprobar lo propio
  assert.equal((await call('POST', '/journeys/j_qa/publish', ...ADMIN)).status, 422);
  assert.equal((await call('POST', '/journeys/j_qa/submit', ...ANA)).status, 200);
  const self = await call('POST', '/journeys/j_qa/approve', 'crm_analyst,approver', 'ana@ss1');
  assert.equal(self.status, 403, 'autor ≠ aprobador');
  assert.equal((await call('POST', '/journeys/j_qa/approve', ...BETO)).status, 200);
  assert.equal((await call('POST', '/journeys/j_qa/publish', ...BETO)).status, 200);

  // 4. ejecución: p1 entra y queda esperando en v1
  app.ingestor.ingest(ev(T, 'p1', 'deposit.settled', { amount_minor: 5_000_000, currency: 'COP', method: 'pse' } as never, clock.now().toISOString()));
  let runs = (await call('GET', '/journeys/j_qa/runs', ...ANA)).body;
  assert.deepEqual([runs.total, runs.by_status.waiting, runs.by_version.v1], [1, 1, 1]);

  // 5. pausa: no entra nadie nuevo y la espera no avanza
  assert.equal((await call('POST', '/journeys/j_qa/pause', ...ANA, { reason: 'revisión de copy' })).status, 200);
  app.ingestor.ingest(ev(T, 'p2', 'deposit.settled', { amount_minor: 5_000_000, currency: 'COP', method: 'pse' } as never, clock.now().toISOString()));
  clock.advance(3 * HOUR); app.runtime.runDue();
  runs = (await call('GET', '/journeys/j_qa/runs', ...ANA)).body;
  assert.deepEqual([runs.total, runs.by_status.waiting], [1, 1], 'pausado: sin entradas nuevas y p1 sigue esperando');
  assert.ok(app.audit.list(T).some((a) => a.action === 'journey.entry_skipped_paused'));

  // 6. reanudar y publicar v2 mientras p1 sigue en v1 (versión fijada)
  assert.equal((await call('POST', '/journeys/j_qa/resume', ...ANA)).status, 200);
  const v2 = [{ id: 'w', type: 'wait', duration_ms: 48 * HOUR, next: 'm' }, ...v1.slice(1)];
  assert.ok((await call('POST', '/journeys', ...ANA, def(v2))).status < 300);
  await call('POST', '/journeys/j_qa/submit', ...ANA);
  await call('POST', '/journeys/j_qa/approve', ...BETO);
  const pub2 = await call('POST', '/journeys/j_qa/publish', ...BETO); assert.equal(pub2.status, 200, JSON.stringify(pub2.body));
  app.ingestor.ingest(ev(T, 'p2', 'deposit.settled', { amount_minor: 6_000_000, currency: 'COP', method: 'pse' } as never, clock.now().toISOString()));
  app.runtime.runDue();
  runs = (await call('GET', '/journeys/j_qa/runs', ...ANA)).body;
  const p1 = app.runtime.instances(T, { player_id: 'p1', journey_id: 'j_qa' })[0];
  assert.equal(p1.version, 1);
  assert.equal(p1.status, 'completed', 'la versión reemplazada deja terminar a quien ya entró (antes quedaba colgado)');
  assert.equal(app.adapters.inapp.list(T, 'p1').items.length, 1, 'p1 recibió su mensaje de v1');
  assert.deepEqual([runs.by_version.v1, runs.by_version.v2, runs.by_status.waiting], [1, 1, 1]);
  assert.deepEqual(runs.versions.map((v: { version: number; status: string }) => `${v.version}:${v.status}`), ['1:archived', '2:published']);

  // 7. cierre: exige motivo y rol; las instancias en curso salen con motivo explícito
  assert.equal((await call('POST', '/journeys/j_qa/close', ...ANA, { reason: 'fin' })).status, 403, 'el analista no cierra');
  assert.equal((await call('POST', '/journeys/j_qa/close', ...ADMIN, {})).status, 422, 'sin motivo no se cierra');
  assert.equal((await call('POST', '/journeys/j_qa/close', ...ADMIN, { reason: 'campaña terminada' })).status, 200);
  clock.advance(49 * HOUR); app.runtime.runDue();
  const p2 = app.runtime.instances(T, { player_id: 'p2', journey_id: 'j_qa' }).at(-1)!;
  assert.equal(p2.status, 'exited');
  assert.equal(p2.trace.at(-1)?.outcome, 'journey_closed');
  assert.equal(app.adapters.inapp.list(T, 'p2').items.length, 0, 'cerrado: no se envía');
  runs = (await call('GET', '/journeys/j_qa/runs', ...ANA)).body;
  assert.deepEqual(runs.versions.map((v: { status: string }) => v.status), ['closed', 'closed']);
  assert.equal((await call('POST', '/journeys/j_qa/resume', ...ADMIN)).status, 422, 'un recorrido cerrado no se reanuda');
  const trail = app.audit.list(T).filter((a) => a.subject.startsWith('j_qa')).map((a) => a.action);
  for (const a of ['journey.draft_saved', 'journey.submitted', 'journey.approved', 'journey.published', 'journey.paused', 'journey.resumed', 'journey.closed']) assert.ok(trail.includes(a), `auditoría: ${a}`);
});

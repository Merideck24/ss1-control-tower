/**
 * Fase 2 · incremento 3 contra PostgreSQL real: instancias, recibos y reprocesos durables.
 * Usa su propia base descartable (crm_test_runtime) para no chocar con db_postgres.test.ts.
 * Se omite sin DATABASE_URL.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createApp, ev, type App } from '../src/app.ts';
import { createPool, type Db } from '../src/persistence/db.ts';
import { migrate, MIGRATIONS_DIR } from '../src/persistence/migrate.ts';
import { bootWithDb, type Booted } from '../src/persistence/boot.ts';
import { PgOpsStore } from '../src/persistence/opsStore.ts';
import { ManualClock } from '../src/shared/util.ts';
import { T, T2 } from './helpers.ts';

const BASE = process.env.DATABASE_URL;
const skip = !BASE;
let admin: Db;
let ADMIN_URL = '', APP_URL = '';
const DBNAME = 'crm_test_runtime';

before(async () => {
  if (skip) return;
  const root = new pg.Client({ connectionString: BASE });
  await root.connect();
  await root.query(`DROP DATABASE IF EXISTS ${DBNAME} WITH (FORCE)`);
  await root.query(`CREATE DATABASE ${DBNAME}`);
  await root.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app_rt') THEN CREATE ROLE crm_app_rt LOGIN PASSWORD 'crm_app_rt'; END IF; END $$;");
  await root.end();
  const u = new URL(BASE!); u.pathname = '/' + DBNAME; ADMIN_URL = u.toString();
  const a = new URL(ADMIN_URL); a.username = 'crm_app_rt'; a.password = 'crm_app_rt'; APP_URL = a.toString();
  admin = createPool(ADMIN_URL);
});
after(async () => { await admin?.end(); });

async function freshSchema(onlyPhase1 = false) {
  await admin.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  let dir = MIGRATIONS_DIR;
  if (onlyPhase1) { dir = await mkdtemp(join(tmpdir(), 'mig1-')); await copyFile(join(MIGRATIONS_DIR, '001_init.sql'), join(dir, '001_init.sql')); }
  await migrate(admin, dir);
  await admin.query('GRANT crm_app TO crm_app_rt');
}

/** Un «proceso»: app nueva (memoria vacía) que arranca desde la base con su rol. */
async function proc(role: 'all' | 'web' | 'worker', clock: ManualClock): Promise<{ app: App; boot: Booted; email: { outbox: { idempotency_key: string }[]; failNext: number; timeoutNext: 'accepted' | 'lost' | null; lookupAvailable: boolean } }> {
  const app = createApp(clock);
  const boot = await bootWithDb(app, { role, tenants: [T, T2], url: APP_URL, maintenanceUrl: ADMIN_URL, log: () => undefined });
  for (const t of [T, T2]) app.policy.markRgFeedSynced(t);
  return { app, boot, email: app.adapters.email as never };
}
const actor = (id: string, role: string) => ({ id, tenant_id: T, roles: [role as never] });
function publish(app: App, id: string, nodes: unknown[], purpose: 'service' | 'marketing' = 'service') {
  app.registry.saveDraft(actor('ana@ss1', 'crm_analyst'), { id, brand_id: 'rumbawin', name: id, purpose, trigger: { event_type: 'deposit.settled' }, entry: nodes[0] && (nodes[0] as { id: string }).id, nodes } as never);
  app.registry.submit(actor('ana@ss1', 'crm_analyst'), id);
  app.registry.approve(actor('beto@ss1', 'approver'), id);
  app.registry.publish(actor('beto@ss1', 'approver'), id);
}
function onboard(app: App, clock: ManualClock, p: string) {
  const now = clock.now().toISOString();
  app.ingestor.ingest(ev(T, p, 'player.registered', { email_masked: 'a***@mail.com', country: 'CO', locale: 'es', timezone: 'America/Bogota' }, now));
  app.ingestor.ingest(ev(T, p, 'rg.status_changed', { status: 'none' }, now));
  app.ingestor.ingest(ev(T, p, 'consent.changed', { purpose: 'marketing', channel: 'email', granted: true }, now));
}
const deposit = (app: App, clock: ManualClock, p: string, id: string) => app.ingestor.ingest(ev(T, p, 'deposit.settled', { deposit_id: id, amount_minor: 5_000_000, currency: 'COP' }, clock.now().toISOString(), { event_id: `dep-${id}` }));
const WAIT_THEN_EMAIL = [{ id: 'w', type: 'wait', duration_ms: 2 * 3_600_000, next: 'm' }, { id: 'm', type: 'message', channel: 'email', template: 'deposit_progress', next: 'e' }, { id: 'e', type: 'exit' }];

test('DB fase 2: actualizar desde la fase 1 conserva los datos y habilita los estados nuevos', { skip }, async () => {
  await freshSchema(true);
  await admin.query(`INSERT INTO delivery_receipts (idempotency_key, tenant_id, player_id, channel, template, locale, status, attempts, at) VALUES ('k-fase1', $1, 'p1', 'email', 'welcome_message', 'es', 'accepted', 1, now())`, [T]);
  await admin.query(`INSERT INTO journey_versions (tenant_id, journey_id, version, status, definition, created_by) VALUES ($1, 'j_old', 1, 'published', '{"id":"j_old"}', 'ana@ss1')`, [T]);
  await assert.rejects(admin.query(`UPDATE delivery_receipts SET status = 'uncertain' WHERE idempotency_key = 'k-fase1'`), /check/i, 'la fase 1 no admite «uncertain»');
  const r = await migrate(admin);
  assert.deepEqual(r.applied, ['002_runtime_persistence.sql']);
  const row = (await admin.query(`SELECT status, attempts, vars, journey_id FROM delivery_receipts WHERE idempotency_key = 'k-fase1'`)).rows[0];
  assert.deepEqual([row.status, row.attempts, row.vars, row.journey_id], ['accepted', 1, null, null], 'el recibo de la fase 1 sigue igual');
  await admin.query(`UPDATE delivery_receipts SET status = 'uncertain' WHERE idempotency_key = 'k-fase1'`);
  await admin.query(`UPDATE journey_versions SET status = 'closed' WHERE journey_id = 'j_old'`);
  const idx = (await admin.query(`SELECT indexname FROM pg_indexes WHERE tablename IN ('delivery_receipts','journey_instances') ORDER BY 1`)).rows.map((x) => x.indexname);
  for (const i of ['delivery_receipts_open', 'delivery_receipts_journey', 'journey_instances_due', 'journey_instances_journey']) assert.ok(idx.includes(i), `índice ${i}`);
  assert.deepEqual((await migrate(admin)).applied, [], 'idempotente');
});

test('DB fase 2: una espera y sus recibos sobreviven al reinicio de la web y del worker, sin reenvíos', { skip }, async () => {
  await freshSchema();
  const clock = new ManualClock('2026-11-20T15:00:00Z');
  let web = await proc('web', clock);
  publish(web.app, 'j_wait', WAIT_THEN_EMAIL);
  onboard(web.app, clock, 'p1');
  deposit(web.app, clock, 'p1', 'd1');
  assert.equal(web.app.runtime.instances(T, { journey_id: 'j_wait' })[0].status, 'waiting');
  await web.boot.stop();                                     // reinicio de la web
  let worker = await proc('worker', clock);
  assert.equal(worker.app.runtime.instances(T, { journey_id: 'j_wait' })[0]?.status, 'waiting', 'el worker la carga en espera');
  await worker.boot.stop();                                  // reinicio del worker antes de que venza
  clock.advance(3 * 3_600_000);
  worker = await proc('worker', clock);
  const t1 = await worker.boot.tick();
  assert.equal(t1.woke, 1, 'el worker nuevo despierta la espera vencida');
  const key = worker.app.channels.receipts(T).find((r) => r.origin?.journey_id === 'j_wait')!.idempotency_key;
  assert.equal(worker.email.outbox.filter((m) => m.idempotency_key === key).length, 1);
  await worker.boot.stop();
  const row = (await admin.query(`SELECT status, journey_id, journey_version, instance_id, node_id, purpose, provider_message_id, vars IS NOT NULL AS has_vars FROM delivery_receipts WHERE idempotency_key = $1`, [key])).rows[0];
  assert.deepEqual([row.status, row.journey_id, row.journey_version, row.node_id, row.purpose, row.has_vars], ['accepted', 'j_wait', 1, 'm', 'service', true]);
  assert.ok(row.provider_message_id && row.instance_id);
  const inst = (await admin.query(`SELECT status, current_node, wake_at, jsonb_array_length(trace) AS steps FROM journey_instances WHERE journey_id = 'j_wait'`)).rows[0];
  assert.deepEqual([inst.status, inst.wake_at], ['completed', null]);
  // web y worker nuevos: ven lo mismo y nadie reenvía
  web = await proc('web', clock);
  worker = await proc('worker', clock);
  assert.equal(web.app.channels.receipt(T, key)?.status, 'accepted');
  assert.equal(web.app.runtime.instances(T, { journey_id: 'j_wait' })[0].status, 'completed');
  clock.advance(5 * 3_600_000);
  assert.equal((await worker.boot.tick()).woke, 0);
  assert.equal(worker.email.outbox.length + web.email.outbox.length, 0, 'sin efectos duplicados tras reiniciar');
  // las versiones también se conservan: no se crean versiones nuevas al reiniciar
  const versions = (await admin.query(`SELECT tenant_id, journey_id, count(*)::int AS n FROM journey_versions GROUP BY tenant_id, journey_id`)).rows;
  assert.ok(versions.every((v) => v.n === 1), JSON.stringify(versions));
  await web.boot.stop(); await worker.boot.stop();
});

test('DB fase 2: el worker ve lo que publica la web y la web ve lo que despierta el worker', { skip }, async () => {
  await freshSchema();
  const clock = new ManualClock('2026-11-20T15:00:00Z');
  const web = await proc('web', clock), worker = await proc('worker', clock);
  publish(web.app, 'j_live', WAIT_THEN_EMAIL);
  onboard(web.app, clock, 'p2');
  deposit(web.app, clock, 'p2', 'd2');
  await web.boot.flush();
  clock.advance(3 * 3_600_000);
  const t = await worker.boot.tick();
  assert.equal(t.woke, 1, 'el worker sincroniza la versión y la instancia y la despierta');
  assert.ok(worker.app.ingestor.get(T, 'p2'), 'el worker proyectó el perfil desde los eventos');
  await web.boot.tick();
  assert.equal(web.app.runtime.instances(T, { journey_id: 'j_live' })[0].status, 'completed', 'la web ve la instancia terminada');
  assert.ok(web.app.channels.receipts(T).some((r) => r.origin?.journey_id === 'j_live' && r.status === 'accepted'), 'y su recibo');
  // los dos procesos auditan a la vez (numeraciones que se solapan)
  for (let i = 0; i < 20; i++) { web.app.audit.record(T, 'web@ss1', 'test.web', `w${i}`); worker.app.audit.record(T, 'worker@ss1', 'test.worker', `k${i}`); }
  await web.boot.stop(); await worker.boot.stop();
  // dos escritores de auditoría a la vez: cada cadena sigue íntegra y no se perdió ningún registro
  const { PgAuditStore } = await import('../src/persistence/stores.ts');
  const v = await new PgAuditStore(admin).verify(admin);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.deepEqual(v.writers.sort(), ['web', 'worker']);
  const n = (await admin.query(`SELECT writer, count(*)::int AS n FROM audit_log GROUP BY writer ORDER BY writer`)).rows;
  assert.ok(n.every((x) => x.n > 0), JSON.stringify(n));
  assert.equal(web.app.audit.list(T).length + web.app.audit.list(T2).length, n.find((x) => x.writer === 'web').n, 'todos los registros de la web están en la base');
  assert.equal(worker.app.audit.list(T).length + worker.app.audit.list(T2).length, n.find((x) => x.writer === 'worker').n, 'y todos los del worker');
});

test('DB fase 2: un envío interrumpido queda «incierto» y se concilia sin reenviar', { skip }, async () => {
  await freshSchema();
  const clock = new ManualClock('2026-11-20T15:00:00Z');
  let w = await proc('all', clock);
  publish(w.app, 'j_now', [{ id: 'm', type: 'message', channel: 'email', template: 'deposit_progress', next: 'e' }, { id: 'e', type: 'exit' }]);
  onboard(w.app, clock, 'p3');
  deposit(w.app, clock, 'p3', 'd3');
  const r = w.app.channels.receipts(T).find((x) => x.origin?.journey_id === 'j_now')!;
  await w.boot.stop();
  // simulamos la caída en medio de la llamada: el último estado escrito es «requested»
  await admin.query(`UPDATE delivery_receipts SET status = 'requested' WHERE idempotency_key = $1`, [r.idempotency_key]);
  w = await proc('all', clock);
  assert.equal(w.boot.loaded.interrupted, 1);
  const f = w.app.failures.get(T, r.idempotency_key)!;
  assert.deepEqual([f.status, f.reason, f.class], ['uncertain', 'interrupted_before_provider_response', 'incierta']);
  // el proveedor sí lo tenía: conciliar sin reenviar
  (w.app.adapters.email as unknown as { outbox: { idempotency_key: string }[] }).outbox.push({ idempotency_key: r.idempotency_key } as never);
  const out = await w.app.failures.reprocess({ id: 'ana@ss1', tenant_id: T }, r.idempotency_key, 'caída del proceso');
  assert.equal(out.outcome, 'reconciled_accepted');
  assert.equal(w.email.outbox.length, 1, 'no se reenvió');
  await w.boot.stop();
  const h = (await admin.query(`SELECT actor, outcome, original_reason FROM reprocess_attempts WHERE idempotency_key = $1`, [r.idempotency_key])).rows;
  assert.deepEqual(h, [{ actor: 'ana@ss1', outcome: 'reconciled_accepted', original_reason: 'interrupted_before_provider_response' }]);
  assert.equal((await admin.query(`SELECT status, reprocess_lock_by FROM delivery_receipts WHERE idempotency_key = $1`, [r.idempotency_key])).rows[0].reprocess_lock_by, null, 'bloqueo liberado');
});

test('DB fase 2: dos réplicas de la web reprocesan la misma falla a la vez → un solo envío', { skip }, async () => {
  await freshSchema();
  const clock = new ManualClock('2026-11-20T15:00:00Z');
  const a = await proc('all', clock);
  publish(a.app, 'j_fail', [{ id: 'm', type: 'message', channel: 'email', template: 'deposit_progress', next: 'e' }, { id: 'e', type: 'exit' }]);
  onboard(a.app, clock, 'p4');
  a.email.failNext = 10;
  deposit(a.app, clock, 'p4', 'd4');
  a.email.failNext = 0;
  const key = a.app.failures.list(T)[0].key;
  await a.boot.flush();
  const b = await proc('web', clock);
  assert.ok(b.app.failures.get(T, key), 'la otra réplica también ve la falla');
  const res = await Promise.allSettled([a.app.failures.reprocess({ id: 'ana@ss1', tenant_id: T }, key, 'a'), b.app.failures.reprocess({ id: 'beto@ss1', tenant_id: T }, key, 'b')]);
  const ok = res.filter((x) => x.status === 'fulfilled').map((x) => (x as PromiseFulfilledResult<{ outcome: string }>).value.outcome);
  const rej = res.filter((x) => x.status === 'rejected').map((x) => ((x as PromiseRejectedResult).reason as { code: string }).code);
  assert.deepEqual([ok, rej], [['accepted'], ['reprocess_in_progress']]);
  assert.equal(a.email.outbox.length + b.email.outbox.length, 1, 'un solo envío entre las dos réplicas');
  await a.boot.stop(); await b.boot.stop();
  // la historia se conserva para un proceso nuevo
  const c = await proc('web', clock);
  assert.equal(c.app.failures.get(T, key)?.history.length, 1);
  assert.equal(c.app.failures.get(T, key)?.status, 'resolved');
  await c.boot.stop();
});

test('DB fase 2: RLS en recibos y reprocesos; un solo worker activo', { skip }, async () => {
  const app = createPool(APP_URL, 2);
  const { withTenant } = await import('../src/persistence/db.ts');
  const seen = await withTenant(app, T2, async (c) => [(await c.query('SELECT count(*)::int AS n FROM delivery_receipts')).rows[0].n, (await c.query('SELECT count(*)::int AS n FROM reprocess_attempts')).rows[0].n]);
  assert.deepEqual(seen, [0, 0], 'otro tenant no ve recibos ni reprocesos');
  await assert.rejects(withTenant(app, T2, (c) => c.query(`INSERT INTO reprocess_attempts (tenant_id, idempotency_key, at, actor, reason, outcome, detail) VALUES ($1,'x',now(),'a','r','o','d')`, [T])), /row-level security|violates/i);
  await assert.rejects(withTenant(app, T, (c) => c.query(`UPDATE reprocess_attempts SET outcome = 'x'`)), /append-only|solo|forbid|permission/i, 'historial solo-anexar');
  const s1 = new PgOpsStore(app), s2 = new PgOpsStore(createPool(APP_URL, 2));
  const l1 = await s1.acquireWorkerLock(), l2 = await s2.acquireWorkerLock();
  assert.deepEqual([l1.held, l2.held], [true, false]);
  await l1.release();
  const l3 = await s2.acquireWorkerLock();
  assert.equal(l3.held, true, 'el segundo toma el relevo');
  await l3.release();
  await app.end();
});

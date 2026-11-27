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
import { createPool, withTenant, type Db } from '../src/persistence/db.ts';
import { migrate, MIGRATIONS_DIR } from '../src/persistence/migrate.ts';
import { bootWithDb, type Booted } from '../src/persistence/boot.ts';
import { PgOpsStore } from '../src/persistence/opsStore.ts';
import { PgLedgerStore } from '../src/persistence/ledgerStore.ts';
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
  assert.deepEqual(r.applied, ['002_runtime_persistence.sql', '003_gamification.sql', '004_ledgers.sql', '005_gifts_contests.sql', '006_leaderboard_prefs.sql']);
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

test('DB fase 2: el ciclo de aprobación sobrevive a la sincronización y al reinicio (firma estable con jsonb)', { skip }, async () => {
  await freshSchema();
  const clock = new ManualClock('2026-11-20T15:00:00Z');
  const a = await proc('web', clock);
  a.app.registry.saveDraft(actor('ana@ss1', 'crm_analyst'), { id: 'j_sig', brand_id: 'rumbawin', name: 'Firma', purpose: 'service', trigger: { event_type: 'deposit.settled' }, entry: 'm', nodes: [{ id: 'm', type: 'message', channel: 'email', template: 'deposit_progress', next: 'e' }, { id: 'e', type: 'exit' }] } as never);
  a.app.registry.submit(actor('ana@ss1', 'crm_analyst'), 'j_sig');
  await a.boot.flush();
  // otra réplica aprueba lo que llegó por la base (antes: la versión restaurada estaba congelada → 500)
  const b = await proc('web', clock);
  b.app.registry.approve(actor('beto@ss1', 'approver'), 'j_sig');
  await b.boot.flush();
  await a.boot.stop(); await b.boot.stop();
  // tras reiniciar, la firma se verifica sobre la copia que devolvió jsonb (antes: «content changed after approval»)
  const c = await proc('web', clock);
  const pub = c.app.registry.publish(actor('beto@ss1', 'approver'), 'j_sig');
  assert.equal(pub.status, 'published');
  await c.boot.stop();
});

test('DB gamificación: retos, inscripciones, logros, alias y enlaces sobreviven al reinicio', { skip }, async () => {
  await freshSchema();
  const clock = new ManualClock('2026-11-20T15:00:00Z');
  let w = await proc('all', clock);
  const ana = { id: 'ana@ss1', tenant_id: T }, beto = { id: 'beto@ss1', tenant_id: T };
  w.app.challenges.saveDraft(ana, { id: 'reto_db', brand_id: 'rumbawin', name: 'Reto DB', description: 'Persistencia', period: 'season', season: 'S1', mode: 'single', reward: { xp: 100 },
    steps: [{ id: 'p', label: 'Completa tu perfil', kind: 'activity', action: 'profile_completed', target: 1 }], starts_at: '2026-11-19T00:00:00Z', ends_at: '2026-12-31T00:00:00Z', timezone: 'America/Bogota' } as never);
  w.app.challenges.submit(ana, 'reto_db'); w.app.challenges.approve(beto, 'reto_db');
  onboard(w.app, clock, 'g1');
  w.app.challenges.enroll(T, 'g1', 'reto_db', true);
  w.app.ingestor.ingest(ev(T, 'g1', 'player.activity' as never, { action: 'profile_completed' } as never, clock.now().toISOString(), { event_id: 'g1-act' }));
  w.app.achievements.setAlias(T, 'g1', 'Gamer_DB', true);
  const link = w.app.achievements.createLink(T, 'rumbawin', 'g1', 'perfil_completo');
  const revoked = w.app.achievements.createLink(T, 'rumbawin', 'g1', 'retador');
  w.app.achievements.revokeLink(T, 'g1', revoked.id);
  await w.boot.stop();
  w = await proc('all', clock);
  const v = w.app.challenges.playerView(T, 'g1').find((c) => c.id === 'reto_db')!;
  assert.deepEqual([v.version, v.enrolled, !!v.completed_at, v.reward_state?.status, v.notify], [1, true, true, 'confirmed', true]);
  const mine = w.app.achievements.mine(T, 'rumbawin', 'g1').filter((a) => a.level).map((a) => a.id).sort();
  assert.deepEqual(mine, ['perfil_completo', 'retador']);
  assert.equal(w.app.achievements.alias(T, 'g1')?.alias, 'Gamer_DB');
  assert.match(w.app.achievements.publicCard(link.id)!.svg, /Gamer_DB/);
  assert.equal(w.app.achievements.publicCard(revoked.id), null, 'el enlace revocado sigue revocado');
  // un evento repetido tras reiniciar no vuelve a contar (idempotencia durable)
  w.app.ingestor.ingest(ev(T, 'g1', 'player.activity' as never, { action: 'profile_completed' } as never, clock.now().toISOString(), { event_id: 'g1-act-2' }));
  // el período ya está completado y persistido: un evento nuevo no lo vuelve a completar ni a premiar
  assert.equal(w.app.audit.list(T).filter((a) => a.action === 'challenge.completed').length, 0, 'no hay una segunda finalización tras reiniciar');
  // el XP que otorgó el reto sobrevive al reinicio (libro durable, migración 004)
  assert.ok(w.app.loyalty.movements(T, 'g1').some((m) => m.ref.includes('reto_db') && m.points === 100), 'el asiento de XP del reto sigue ahí');
  assert.equal(w.app.loyalty.balance(T, 'g1', '2026-Q4'), 100);
  await w.boot.stop();
});

test('DB libros: XP y monedas sobreviven al reinicio, la otra réplica los recibe y nada se cuenta dos veces', { skip }, async () => {
  await freshSchema();
  const clock = new ManualClock('2026-11-20T15:00:00Z');
  const ana = { id: 'ana@ss1', tenant_id: T };
  let web = await proc('web', clock);
  const worker = await proc('worker', clock);
  onboard(web.app, clock, 'l1');
  web.app.loyalty.award(T, 'rumbawin', 'l1', 1500, 'mission:m1', 'mission:m1:l1');   // sube a Plata
  web.app.store.adjust(ana, 'l1', 40, 'ajuste de prueba', 'a1');
  web.app.store.adjust(ana, 'l1', -15, 'ajuste de prueba', 'a2');
  web.app.loyalty.reverse(T, 'rumbawin', 'mission:m1:l1', 'reverso de prueba');
  web.app.loyalty.award(T, 'rumbawin', 'l1', 300, 'mission:m2', 'mission:m2:l1');
  await web.boot.flush();
  const ledgers = new PgLedgerStore(web.boot.db);
  assert.equal(await ledgers.balance(T, 'l1'), 25, 'saldo de monedas mantenido en la base');
  // la otra réplica recibe los asientos en su ciclo, sin efectos (no vuelve a avisar la subida de nivel)
  const ups = worker.app.audit.list(T).length;
  await worker.boot.tick();
  assert.equal(worker.app.loyalty.balance(T, 'l1', '2026-Q4'), 300);
  assert.equal(worker.app.store.balance(T, 'l1'), 25);
  assert.equal(worker.app.audit.list(T).length, ups, 'sincronizar no genera efectos');
  await web.boot.stop(); await worker.boot.stop();
  web = await proc('web', clock);
  assert.equal(web.app.loyalty.balance(T, 'l1', '2026-Q4'), 300, 'XP tras reiniciar');
  assert.equal(web.app.store.balance(T, 'l1'), 25, 'monedas tras reiniciar');
  assert.equal(web.app.loyalty.movements(T, 'l1').filter((m) => m.compensates).length, 1, 'el asiento compensatorio sigue');
  // repetir la misma referencia tras reiniciar no vuelve a sumar (idempotencia durable)
  assert.equal(web.app.loyalty.award(T, 'rumbawin', 'l1', 300, 'mission:m2', 'mission:m2:l1'), undefined);
  assert.equal(web.app.store.adjust(ana, 'l1', 40, 'ajuste de prueba', 'a1').entry, null);
  // la base rechaza un saldo de monedas negativo aunque una réplica desactualizada lo intente
  await assert.rejects(withTenant(web.boot.db, T, (c) => c.query(`UPDATE coin_balances SET balance = balance - 1000 WHERE player_id = 'l1'`)), /check/i);
  await web.boot.stop();
});

test('DB regalos: la campaña, la asignación y la reclamación sobreviven al reinicio; reclamar de nuevo no duplica', { skip }, async () => {
  await freshSchema();
  const clock = new ManualClock('2026-11-20T15:00:00Z');
  const A = { id: 'ana@ss1', tenant_id: T }, B = { id: 'beto@ss1', tenant_id: T };
  let w = await proc('all', clock);
  onboard(w.app, clock, 'q1'); onboard(w.app, clock, 'q2');
  w.app.gifts.saveDraft(A, { id: 'reg_db', brand_id: 'rumbawin', name: 'Regalo DB', message: 'Un detalle para ti', reward: { xp: 120, coins: 10 }, audience: { players: ['q1', 'q2'] }, max_recipients: 10, expires_at: '2026-12-01T00:00:00Z' } as never);
  w.app.gifts.submit(A, 'reg_db'); w.app.gifts.approve(B, 'reg_db');
  w.app.gifts.claim(T, 'q1', 'reg_db');
  await w.boot.stop();
  w = await proc('all', clock);
  assert.equal(w.app.gifts.get(T, 'reg_db')?.status, 'active');
  assert.deepEqual(w.app.gifts.mine(T, 'q1').map((g) => g.status), ['claimed']);
  assert.deepEqual(w.app.gifts.mine(T, 'q2').map((g) => g.status), ['available']);
  assert.equal(w.app.loyalty.balance(T, 'q1', '2026-Q4'), 120);
  w.app.gifts.claim(T, 'q1', 'reg_db');
  assert.equal(w.app.loyalty.balance(T, 'q1', '2026-Q4'), 120, 'sin segunda entrega');
  assert.equal(w.app.store.balance(T, 'q1'), 10);
  await w.boot.stop();
});

test('DB torneos y clasificaciones: reglas, puntajes, cierre pendiente de aprobación y «ocultarme» sobreviven al reinicio', { skip }, async () => {
  await freshSchema();
  const clock = new ManualClock('2026-11-20T15:00:00Z');
  const A = { id: 'ana@ss1', tenant_id: T };
  let w = await proc('all', clock);
  for (const p of ['t1', 't2']) onboard(w.app, clock, p);
  w.app.games.saveTournament(A, { id: 't_db', brand_id: 'rumbawin', name: 'Torneo DB', metric: 'bet_count', product: 'sports', starts_at: '2026-11-20T00:00:00Z', ends_at: '2026-11-21T00:00:00Z', min_score: 1, enrollment: 'opt_in', prizes: [{ from: 1, to: 1, prize: { xp: 400 } }] } as never);
  const act = w.app.games.activateTournament({ ...A, canApprove: false }, 't_db');
  w.app.games.enrollTournament(T, 't1', 't_db'); w.app.games.enrollTournament(T, 't2', 't_db');
  const bet = (p: string, id: string) => w.app.ingestor.ingest(ev(T, p, 'bet.settled', { bet_id: id, stake: { amount_minor: 100_000, currency: 'COP' }, product: 'sports' }, clock.now().toISOString(), { event_id: id }));
  bet('t1', 'tb1'); bet('t1', 'tb2'); bet('t2', 'tb3');
  w.app.leaderboards.setHidden(T, 't2', true);
  await w.boot.stop();
  w = await proc('all', clock);
  assert.equal(w.app.games.tournament(T, 't_db')?.rules_hash, act.rules_hash, 'reglas fijadas');
  assert.deepEqual(w.app.games.standings(T, 't_db').map((s) => [s.player_id, s.score]), [['t1', 2], ['t2', 1]]);
  assert.ok(w.app.games.isEnrolled(T, 't2', 't_db'));
  assert.equal(w.app.leaderboards.board(T, 'tournament', 't_db', { viewer: 't1' }).rows[1].display, 'Jugador oculto');
  clock.set('2026-11-21T02:00:00Z');
  const closed = w.app.games.finalizeTournament(A, 't_db');
  await w.boot.stop();
  w = await proc('all', clock);
  assert.equal(w.app.games.tournament(T, 't_db')?.status, 'results_pending');
  const xp0 = w.app.loyalty.balance(T, 't1', '2026-Q4');
  const fin = w.app.games.approveResults({ id: 'beto@ss1', tenant_id: T }, 't_db');
  assert.equal(fin.final!.hash, closed.results!.hash);
  assert.equal(w.app.loyalty.balance(T, 't1', '2026-Q4') - xp0, 400, 'premio pagado al aprobar');
  await w.boot.stop();
});

test('DB concursos: bases, participaciones, descalificación y compromiso del sorteo sobreviven al reinicio; el sorteo se verifica después', { skip }, async () => {
  await freshSchema();
  const clock = new ManualClock('2026-11-20T15:00:00Z');
  const A = { id: 'ana@ss1', tenant_id: T }, B = { id: 'beto@ss1', tenant_id: T };
  let w = await proc('all', clock);
  for (const p of ['c1', 'c2', 'c3']) onboard(w.app, clock, p);
  w.app.contests.saveDraft(A, { id: 'conc_db', brand_id: 'rumbawin', name: 'Concurso DB', rules: 'Participa gratis. Sin compra ni apuesta. Un ganador elegido por sorteo verificable con semilla.', kind: 'draw', requirements: {}, opens_at: '2026-11-20T00:00:00Z', closes_at: '2026-11-25T00:00:00Z', prizes: [{ place: 1, label: '200 XP', xp: 200 }] } as never);
  w.app.contests.submit(A, 'conc_db');
  const ap = w.app.contests.approve(B, 'conc_db');
  for (const p of ['c1', 'c2', 'c3']) w.app.contests.enter(T, p, 'conc_db', { accept_rules: true });
  w.app.contests.disqualify(A, 'conc_db', 'c3', 'duplicate_account', 'Cuenta duplicada confirmada por soporte');
  await w.boot.stop();
  w = await proc('all', clock);
  assert.equal(w.app.contests.get(T, 'conc_db')?.draw?.seed_commit, ap.draw!.seed_commit);
  assert.deepEqual(w.app.contests.entries(T, 'conc_db').map((e) => [e.player_id, e.status]).sort(), [['c1', 'valid'], ['c2', 'valid'], ['c3', 'disqualified']]);
  w.app.contests.close(A, 'conc_db');
  const dr = w.app.contests.drawWinners(A, 'conc_db');
  assert.ok(['c1', 'c2'].includes(dr.winners![0].player_id));
  const pr = w.app.contests.verifyDraw(T, 'conc_db');
  assert.deepEqual([pr.commit_matches, pr.reproduced], [true, true], 'la semilla persistida coincide con el compromiso publicado');
  await w.boot.stop();
});

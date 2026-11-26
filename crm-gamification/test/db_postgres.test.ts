/**
 * Pruebas contra PostgreSQL real. Se omiten sin DATABASE_URL (rol con permisos de
 * administración sobre una base de pruebas DESCARTABLE: se recrea el esquema public).
 * CI levanta un servicio postgres:16 (ver .github/workflows/crm-gamification.yml).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createPool, withTenant, type Db } from '../src/persistence/db.ts';
import { migrate, MIGRATIONS_DIR } from '../src/persistence/migrate.ts';
import { PgAuditStore, PgEventStore, attachPersistence, rebuildFromStore } from '../src/persistence/stores.ts';
import { onboard, ev, T, T2 } from './helpers.ts';
import { createApp, seedTenant } from '../src/app.ts';
import { ManualClock } from '../src/shared/util.ts';

const URL = process.env.DATABASE_URL;
const skip = !URL;
let db: Db;
let appDb: Db; // conexión con el rol crm_app (sujeta a RLS)

before(async () => {
  if (skip) return;
  db = createPool(URL);
  await db.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await db.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app_test') THEN CREATE ROLE crm_app_test LOGIN PASSWORD 'crm_app_test'; END IF; END $$;");
  await migrate(db);
  await db.query('GRANT crm_app TO crm_app_test');
  const u = new globalThis.URL(URL!); u.username = 'crm_app_test'; u.password = 'crm_app_test';
  appDb = createPool(u.toString());
});
after(async () => { await appDb?.end(); await db?.end(); });

test('DB: migraciones idempotentes y protegidas contra cambios de archivos ya aplicados', { skip }, async () => {
  const again = await migrate(db);
  assert.deepEqual(again.applied, []); assert.ok(again.skipped.includes('001_init.sql'));
  const dir = await mkdtemp(join(tmpdir(), 'mig-'));
  await writeFile(join(dir, '001_init.sql'), (await readFile(join(MIGRATIONS_DIR, '001_init.sql'), 'utf8')) + '\n-- editado');
  await assert.rejects(migrate(db, dir), /cambió después de aplicarse/);
});

test('DB: RLS — cada tenant solo ve y escribe sus filas; sin tenant no ve nada', { skip }, async () => {
  const store = new PgEventStore(appDb);
  const e1 = ev(T, 'rls1', 'player.registered', { email_masked: 'a***@m.co', country: 'CO', locale: 'es', timezone: 'America/Bogota' }, '2026-11-01T10:00:00Z');
  const e2 = ev(T2, 'rls2', 'player.registered', { email_masked: 'b***@m.co', country: 'CO', locale: 'es', timezone: 'America/Bogota' }, '2026-11-01T10:00:00Z');
  assert.equal(await store.append(e1), true); assert.equal(await store.append(e2), true);
  assert.equal(await store.append(e1), false, 'mismo event_id ⇒ no se duplica');
  const seen = await withTenant(appDb, T, async (c) => (await c.query('SELECT player_id FROM events')).rows.map((r) => r.player_id));
  assert.deepEqual(seen, ['rls1']);
  assert.equal((await appDb.query('SELECT count(*)::int n FROM events')).rows[0].n, 0, 'sin app.tenant_id no se ve nada');
  await assert.rejects(withTenant(appDb, T, (c) => c.query(`INSERT INTO events (tenant_id, event_id, event_type, schema_version, brand_id, occurred_at, source, correlation_id, payload) VALUES ($1,'x','player.verified',1,'b',now(),'s','c','{}')`, [T2])), /row-level security/);
});

test('DB: eventos y auditoría son solo-anexar; la base hace cumplir presupuesto, saldo y un caso JR abierto', { skip }, async () => {
  await assert.rejects(db.query("UPDATE events SET source = 'x'"), /solo-anexar/);
  await assert.rejects(withTenant(appDb, T, (c) => c.query("UPDATE events SET source = 'x'")), /permission denied|solo-anexar/);
  await withTenant(appDb, T, async (c) => {
    await c.query(`INSERT INTO reward_items (tenant_id, reward_id, brand_id, reward_type, value_minor, currency, validity_days, budget_minor) VALUES ($1,'r1','b','bonus',100,'COP',7,250)`, [T]);
    await c.query(`UPDATE reward_items SET committed_minor = committed_minor + 100 WHERE reward_id = 'r1'`);
    await c.query(`UPDATE reward_items SET committed_minor = committed_minor + 100 WHERE reward_id = 'r1'`);
  });
  await assert.rejects(withTenant(appDb, T, (c) => c.query(`UPDATE reward_items SET committed_minor = committed_minor + 100 WHERE reward_id = 'r1'`)), /check constraint/, 'el presupuesto no se excede');
  await assert.rejects(withTenant(appDb, T, (c) => c.query(`INSERT INTO coin_balances (tenant_id, player_id, balance) VALUES ($1,'p',-1)`, [T])), /check constraint/);
  await withTenant(appDb, T, (c) => c.query(`INSERT INTO rg_cases (case_id, tenant_id, player_id, level, score, signals, opened_at, status) VALUES ('c1',$1,'p','high',70,'[]',now(),'open')`, [T]));
  await assert.rejects(withTenant(appDb, T, (c) => c.query(`INSERT INTO rg_cases (case_id, tenant_id, player_id, level, score, signals, opened_at, status) VALUES ('c2',$1,'p','medium',40,'[]',now(),'open')`, [T])), /duplicate key/);
});

test('DB: la app persiste eventos y auditoría; al reiniciar se reconstruyen perfiles y métricas, y la cadena de auditoría continúa', { skip }, async () => {
  await db.query('DELETE FROM player_profiles'); // limpia restos; events es solo-anexar, se usan jugadores nuevos
  const events = new PgEventStore(appDb), audit = new PgAuditStore(appDb);
  // arranque real: conectar la base ANTES de sembrar, para que toda la cadena quede guardada
  const clock = new ManualClock('2026-11-15T15:00:00Z');
  const app = createApp(clock);
  const last = await audit.last(db);
  if (last) app.audit.resume(last.seq, last.hash);
  const p = attachPersistence(app, events, audit);
  seedTenant(app, T); seedTenant(app, T2);
  for (const id of ['re1', 're2', 're3']) {
    onboard(app, clock, id);
    app.ingestor.ingest(ev(T, id, 'deposit.settled', { deposit_id: `${id}d`, amount_minor: 150_000, currency: 'COP' }, clock.now().toISOString()));
    app.ingestor.ingest(ev(T, id, 'bet.settled', { bet_id: `${id}b`, stake: { amount_minor: 50_000, currency: 'COP' }, win: { amount_minor: 10_000, currency: 'COP' }, product: 'casino' }, clock.now().toISOString()));
  }
  await p.flush();
  assert.ok((await events.count(T)) >= 18, 'eventos de entrada y derivados (bono, señales) guardados');
  // «reinicio»: app nueva, misma base
  // orden de arranque real: continuar la cadena de auditoría → conectar la base → sembrar → reconstruir
  const app2 = createApp(new ManualClock(clock.now().toISOString()));
  const before = await audit.last(db);
  app2.audit.resume(before!.seq, before!.hash);
  const p2 = attachPersistence(app2, events, audit);
  seedTenant(app2, T); seedTenant(app2, T2);
  const r = await rebuildFromStore(app2, events, [T]);
  assert.ok(r.events >= 18);
  for (const id of ['re1', 're2', 're3']) {
    const a = app.ingestor.get(T, id)!, b = app2.ingestor.get(T, id)!;
    assert.deepEqual(b.stats, a.stats); assert.equal(b.kyc?.value, a.kyc?.value); assert.deepEqual(b.rewards, a.rewards);
  }
  const ra = app.performance.report(T, { to: clock.now(), days: 30 }).totals, rb = app2.performance.report(T, { to: clock.now(), days: 30 }).totals;
  assert.equal(rb.deposits_minor, ra.deposits_minor); assert.equal(rb.ggr_minor, ra.ggr_minor);
  assert.equal(app2.ingestor.ingest(ev(T, 're1', 'deposit.settled', { deposit_id: 're1d', amount_minor: 150_000, currency: 'COP' }, clock.now().toISOString(), { event_id: (await (async () => { for await (const e of events.stream(T)) if (e.event_type === 'deposit.settled' && e.player_id === 're1') return e.event_id; return ''; })()) })).status, 'duplicate', 'la deduplicación sobrevive al reinicio');
  // la auditoría sigue la misma cadena tras el reinicio
  app2.audit.record(T, 'ops@ss1', 'system.restarted', 'crm', {});
  await p2.flush();
  const v = await audit.verify(db);
  assert.equal(v.ok, true, JSON.stringify(v)); assert.ok(v.entries > before!.seq);
  assert.equal(v.entries, (await audit.last(db))!.seq, 'sin huecos ni duplicados en la numeración');
  // alterar un registro (saltando el trigger como superusuario) se detecta
  await db.query('ALTER TABLE audit_log DISABLE TRIGGER audit_append_only');
  await db.query(`UPDATE audit_log SET actor = 'intruso' WHERE seq = 2`);
  await db.query('ALTER TABLE audit_log ENABLE TRIGGER audit_append_only');
  assert.deepEqual(await audit.verify(db), { ok: false, entries: v.entries, broken_at: 2, writer: 'web', writers: ['web'] });
  void pg;
});

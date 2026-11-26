/**
 * Worker de recorridos (Fase 2): despierta esperas y diferidos guardados en PostgreSQL.
 *
 *   DATABASE_URL=… npm run worker
 *
 * Un solo worker activo: si otro ya tiene el bloqueo, este queda en espera y lo toma cuando el
 * activo se detenga. Al arrancar, los envíos que quedaron «requested» pasan a «uncertain».
 */
import { createApp } from './app.ts';
import { OffsetClock } from './shared/util.ts';
import { bootWithDb } from './persistence/boot.ts';
import { PgOpsStore } from './persistence/opsStore.ts';
import { createPool } from './persistence/db.ts';

const tenants = (process.env.CRM_TENANTS ?? 'tenant-rumbawin,tenant-demo-b').split(',').map((t) => t.trim()).filter(Boolean);
const every = Number(process.env.CRM_WORKER_INTERVAL_MS ?? 1000);
const name = process.env.CRM_WORKER_NAME ?? `worker-${process.pid}`;

const lockPool = createPool(process.env.DATABASE_URL, 1);
const lockStore = new PgOpsStore(lockPool);
let lock = await lockStore.acquireWorkerLock();
while (!lock.held) {
  console.log(`[${name}] otro worker está activo; en espera.`);
  await new Promise((r) => setTimeout(r, 5_000));
  lock = await lockStore.acquireWorkerLock();
}

const app = createApp(new OffsetClock(), { demoProviders: !process.env.CRM_PROVIDERS_LIVE });
const boot = await bootWithDb(app, { role: 'worker', tenants, writer: process.env.CRM_AUDIT_WRITER, maintenanceUrl: process.env.DATABASE_MAINTENANCE_URL, log: (m) => console.log(`[${name}] ${m}`) });
const heartbeat = () => tenants.forEach((t) => app.policy.markRgFeedSynced(t)); // demo: el feed JR lo publica la fuente en producción
heartbeat();
const hb = setInterval(heartbeat, 60_000);
const loop = setInterval(async () => {
  try {
    const r = await boot.tick();
    if (r.woke) console.log(`[${name}] ${r.woke} esperas despertadas`);
  } catch (e) { console.error(`[${name}]`, (e as Error).message); }
}, every);
console.log(`[${name}] activo: revisa esperas cada ${every} ms.`);

const stop = async (sig: string) => {
  console.log(`[${name}] ${sig}: guardando y deteniendo.`);
  clearInterval(loop); clearInterval(hb);
  await boot.stop().catch(() => undefined);
  await lock.release(); await lockPool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));

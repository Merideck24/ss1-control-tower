/**
 * Arranque con PostgreSQL, común al servidor web y al worker.
 *
 * Orden: auditoría continúa → recorridos, instancias y recibos se cargan → ganchos de escritura →
 * catálogos del tenant (los recorridos ya cargados no se vuelven a crear) → perfiles desde eventos
 * (sin efectos) → ciclos: seguir eventos nuevos, sincronizar operación y, si corresponde, despertar esperas.
 *
 * Quien recibe un evento de primera mano ejecuta sus efectos; el otro proceso solo lo proyecta.
 */
import type { App } from '../app.ts';
import { seedTenant } from '../app.ts';
import { createPool, type Db } from './db.ts';
import { attachOps, loadOps, syncOps, type OpsRole } from './ops.ts';
import { PgOpsStore } from './opsStore.ts';
import { PgAuditStore, PgEventStore, attachPersistence, rebuildFromStore } from './stores.ts';

export type Booted = { db: Db; ops: PgOpsStore; flush: () => Promise<void>; tick: () => Promise<{ events: number; synced: number; woke: number }>; stop: () => Promise<void>; loaded: Awaited<ReturnType<typeof loadOps>>['counts']; events: number };

export async function bootWithDb(app: App, o: { role: OpsRole; tenants: string[]; url?: string; maintenanceUrl?: string; writer?: string; log?: (m: string) => void }): Promise<Booted> {
  const log = o.log ?? ((m: string) => console.log(m));
  const db = createPool(o.url);
  const maintenance = o.maintenanceUrl ? createPool(o.maintenanceUrl, 2) : db;
  const events = new PgEventStore(db), audit = new PgAuditStore(db, o.writer ?? (o.role === 'worker' ? 'worker' : 'web')), ops = new PgOpsStore(db);
  const last = await audit.last(maintenance);
  if (last) app.audit.resume(last.seq, last.hash);
  const persist = attachPersistence(app, events, audit);
  // lo que quedó a medio enviar solo lo marca quien despierta esperas (worker o proceso único)
  const loaded = await loadOps(app, ops, o.tenants, { interrupted: o.role !== 'web' });
  let cursor = loaded.cursor;
  const opsP = attachOps(app, ops);
  // el worker no crea recorridos: los recibe de la base (los publica la web)
  for (const t of o.tenants) { seedTenant(app, t, 'rumbawin', { journeys: o.role !== 'worker' }); app.policy.markRgFeedSynced(t); }
  const seqs = new Map<string, number>();
  const r = await rebuildFromStore(app, events, o.tenants, seqs);
  const flush = async () => { await persist.flush(); await opsP.flush(); };
  await flush();
  log(`PostgreSQL (${o.role}): ${r.events} eventos reconstruidos · ${loaded.counts.versions} versiones, ${loaded.counts.instances} instancias (${loaded.counts.waiting} en espera), ${loaded.counts.receipts} recibos${loaded.counts.interrupted ? ` · ${loaded.counts.interrupted} envíos interrumpidos pasan a «incierto»` : ''} · auditoría desde #${last?.seq ?? 0}.`);
  let busy = false;
  const tick = async () => {
    if (busy) return { events: 0, synced: 0, woke: 0 };
    busy = true;
    try {
      // eventos que escribió el otro proceso: solo proyección (sus efectos ya corrieron allá)
      const ev = await rebuildFromStore(app, events, o.tenants, seqs);
      const s = await syncOps(app, ops, o.tenants, cursor, flush);
      cursor = s.cursor;
      const woke = o.role === 'web' ? 0 : app.runtime.runDue();
      await flush();
      return { events: ev.events, synced: s.changed, woke };
    } finally { busy = false; }
  };
  return {
    db, ops, flush, tick, loaded: loaded.counts, events: r.events,
    stop: async () => { await flush(); if (maintenance !== db) await maintenance.end(); await db.end(); },
  };
}

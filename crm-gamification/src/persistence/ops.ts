/**
 * Conecta la app con la persistencia de operación (docs/DATABASE.md, Fase 2).
 *
 * Roles de proceso:
 *  · all    — un solo proceso hace todo (desarrollo, demo con base).
 *  · web    — API y eventos: ejecuta el primer paso de cada recorrido al llegar el evento, NO despierta
 *             esperas. Lee de la base lo que el worker cambia (sincronización por updated_at).
 *  · worker — sin API: reconstruye perfiles desde la base (sin efectos), sigue los eventos nuevos y es
 *             el único que despierta esperas y diferidos. Un solo worker activo (bloqueo consultivo).
 *
 * Toda escritura se encola y se escribe por lotes en orden: versiones → instancias → recibos → reprocesos.
 */
import type { App } from '../app.ts';
import { isSent, type Receipt } from '../channels/channels.ts';
import type { ReprocessAttempt } from '../channels/failures.ts';
import type { JourneyDefinition } from '../journeys/model.ts';
import type { InstanceRecord } from '../journeys/runtime.ts';
import { DomainError } from '../shared/util.ts';
import type { PgOpsStore } from './opsStore.ts';

export type OpsRole = 'all' | 'web' | 'worker';

type Pending = { versions: Map<string, JourneyDefinition>; instances: Map<string, InstanceRecord>; receipts: Map<string, Receipt>; attempts: { key: string; a: ReprocessAttempt; original?: { reason: string; status: string } }[] };
const empty = (): Pending => ({ versions: new Map(), instances: new Map(), receipts: new Map(), attempts: [] });

export function attachOps(app: App, store: PgOpsStore, onError: (e: unknown) => void = (e) => console.error('[persistencia de operación]', e)) {
  const byTenant = new Map<string, Pending>();
  const q = (t: string) => { let p = byTenant.get(t); if (!p) byTenant.set(t, (p = empty())); return p; };
  let chain: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const drain = async () => {
    const batches = [...byTenant]; byTenant.clear();
    for (const [t, p] of batches) {
      await store.upsertVersions(t, [...p.versions.values()]);
      await store.upsertInstances(t, [...p.instances.values()]);
      await store.upsertReceipts(t, [...p.receipts.values()]);
      for (const x of p.attempts) await store.appendAttempt(t, x.key, x.a, x.original);
    }
  };
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; chain = chain.then(drain).catch(onError); }, 20); };
  const flush = async () => {
    while (timer || byTenant.size) {
      if (timer) { clearTimeout(timer); timer = null; }
      chain = chain.then(drain).catch(onError);
      await chain;
    }
    await chain;
  };

  // recorridos: las seis operaciones que cambian versiones
  const reg = app.registry as unknown as Record<string, (...a: unknown[]) => JourneyDefinition>;
  for (const m of ['saveDraft', 'submit', 'approve', 'publish', 'setPaused', 'close']) {
    const orig = reg[m].bind(app.registry);
    reg[m] = (...args: unknown[]) => {
      const out = orig(...args);
      for (const v of app.registry.versionsOf(out.tenant_id, out.id)) q(out.tenant_id).versions.set(`${v.id}@${v.version}`, v);
      schedule();
      return out;
    };
  }
  app.runtime.onChange = (xs) => { for (const i of xs) q(i.tenant_id).instances.set(i.instance_id, structuredClone(i)); schedule(); };
  const prevReceipt = app.channels.onReceipt;
  app.channels.onReceipt = (r) => { prevReceipt?.(r); q(r.tenant_id).receipts.set(r.idempotency_key, r); schedule(); };

  // reproceso: bloqueo en la base antes del efecto, historial durable
  app.failures.beforeEffect = async (t, key, actor) => {
    await flush();
    if (!(await store.claimReprocess(t, key, actor))) throw new DomainError('reprocess_in_progress', 'Otro operador o proceso está reprocesando esta falla, o ya se resolvió. Recarga la cola.');
  };
  app.failures.afterEffect = async (t, key) => { await flush(); await store.releaseReprocess(t, key); };
  app.failures.onAttempt = (t, key, a, original) => { q(t).attempts.push({ key, a, original }); schedule(); };

  return { flush, get pending() { let n = 0; for (const p of byTenant.values()) n += p.versions.size + p.instances.size + p.receipts.size + p.attempts.length; return n; } };
}

/** Restaura en memoria lo guardado. No emite efectos ni vuelve a escribir. */
function restore(app: App, data: { versions: JourneyDefinition[]; instances: InstanceRecord[]; receipts: Receipt[]; attempts: Awaited<ReturnType<PgOpsStore['loadAttempts']>> }) {
  app.registry.restore(data.versions);
  // una instancia cuya versión no llegó aún se restaura igual: el runtime la ignora hasta que exista
  app.runtime.restore(data.instances);
  app.channels.restore(data.receipts);
  for (const r of data.receipts) {
    if (isSent(r.status) && r.origin?.purpose === 'marketing') app.policy.recordMarketingSend({ tenant_id: r.tenant_id, player_id: r.player_id }, r.channel, Date.parse(r.provider_at ?? r.at));
  }
  app.failures.restoreHistory(data.attempts);
}

/**
 * Carga al arrancar. `interrupted` (worker o proceso único): lo que quedó «requested» pasa a
 * «uncertain» antes de cargar. Devuelve el cursor para la sincronización posterior.
 */
export async function loadOps(app: App, store: PgOpsStore, tenants: string[], opts: { interrupted?: boolean } = {}): Promise<{ cursor: string; counts: { versions: number; instances: number; waiting: number; receipts: number; interrupted: number } }> {
  const cursor = await store.now();
  const counts = { versions: 0, instances: 0, waiting: 0, receipts: 0, interrupted: 0 };
  for (const t of tenants) {
    if (opts.interrupted) counts.interrupted += await store.markInterrupted(t);
    const data = { versions: await store.loadVersions(t), instances: await store.loadInstances(t), receipts: await store.loadReceipts(t), attempts: await store.loadAttempts(t) };
    restore(app, data);
    counts.versions += data.versions.length; counts.instances += data.instances.length; counts.receipts += data.receipts.length;
    counts.waiting += data.instances.filter((i) => i.status === 'waiting').length;
  }
  return { cursor, counts };
}

/** Trae lo que otro proceso cambió desde `cursor` (con 5 s de solape: restaurar es idempotente). */
export async function syncOps(app: App, store: PgOpsStore, tenants: string[], cursor: string, flush?: () => Promise<void>): Promise<{ cursor: string; changed: number }> {
  await flush?.(); // primero se escribe lo propio: así lo que se lee de la base nunca es más viejo que lo local
  const next = await store.now();
  const since = new Date(Date.parse(cursor) - 5_000).toISOString();
  let changed = 0;
  for (const t of tenants) {
    const data = { versions: await store.loadVersions(t, since), instances: await store.loadInstances(t, since), receipts: await store.loadReceipts(t, since), attempts: await store.loadAttempts(t, since) };
    restore(app, data);
    changed += data.versions.length + data.instances.length + data.receipts.length + data.attempts.length;
  }
  return { cursor: next, changed };
}

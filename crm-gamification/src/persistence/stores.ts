/**
 * Fase 1 de persistencia: lo que no se puede perder.
 *  · Registro de eventos (fuente de verdad, solo-anexar, deduplicado por tenant+event_id).
 *  · Auditoría encadenada (solo-anexar, verificable).
 * Las proyecciones (perfiles, métricas, señales) se reconstruyen desde el registro al
 * arrancar. Los módulos con estado propio (recorridos en curso, otorgamientos, saldos,
 * casos…) tienen sus tablas en 001_init.sql y migran en la fase 2 (ver docs/DATABASE.md).
 */
import type { AuditEntry, AuditLog } from '../audit/audit.ts';
import type { EventEnvelope } from '../domain/events.ts';
import { sha256 } from '../shared/util.ts';
import type { App } from '../app.ts';
import { withTenant, type Db } from './db.ts';

export class PgEventStore {
  #db: Db;
  constructor(db: Db) { this.#db = db; }

  /** Inserta si no existe. Devuelve true si el evento es nuevo. */
  async append(e: EventEnvelope): Promise<boolean> {
    return withTenant(this.#db, e.tenant_id, async (c) => {
      const r = await c.query(
        `INSERT INTO events (tenant_id, event_id, event_type, schema_version, brand_id, player_id, occurred_at, received_at, source, correlation_id, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()),$9,$10,$11) ON CONFLICT (tenant_id, event_id) DO NOTHING`,
        [e.tenant_id, e.event_id, e.event_type, e.schema_version, e.brand_id, e.player_id ?? '', e.occurred_at, e.received_at ?? null, e.source, e.correlation_id, JSON.stringify(e.payload)]);
      return r.rowCount === 1;
    });
  }

  /** Inserción por lotes de un mismo tenant, en una transacción. Devuelve cuántos eran nuevos. */
  async appendMany(tenant: string, es: EventEnvelope[]): Promise<number> {
    if (!es.length) return 0;
    return withTenant(this.#db, tenant, async (c) => {
      let inserted = 0;
      for (let i = 0; i < es.length; i += 500) {
        const vals: unknown[] = [];
        const rows = es.slice(i, i + 500).map((e, k) => {
          const o = k * 11;
          vals.push(e.tenant_id, e.event_id, e.event_type, e.schema_version, e.brand_id, e.player_id ?? '', e.occurred_at, e.received_at ?? null, e.source, e.correlation_id, JSON.stringify(e.payload));
          return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},COALESCE($${o + 8}::timestamptz, now()),$${o + 9},$${o + 10},$${o + 11})`;
        });
        const r = await c.query(`INSERT INTO events (tenant_id, event_id, event_type, schema_version, brand_id, player_id, occurred_at, received_at, source, correlation_id, payload) VALUES ${rows.join(',')} ON CONFLICT (tenant_id, event_id) DO NOTHING`, vals);
        inserted += r.rowCount ?? 0;
      }
      return inserted;
    });
  }

  async count(tenant: string): Promise<number> {
    return withTenant(this.#db, tenant, async (c) => Number((await c.query('SELECT count(*)::int AS n FROM events')).rows[0].n));
  }

  /** Recorre los eventos en orden de llegada, por lotes (cursor por seq). */
  async *stream(tenant: string, batch = 2000): AsyncGenerator<EventEnvelope> {
    let after = 0;
    for (;;) {
      const rows = await withTenant(this.#db, tenant, async (c) => (await c.query(
        `SELECT seq, event_id, event_type, schema_version, tenant_id, brand_id, player_id, occurred_at, received_at, source, correlation_id, payload
         FROM events WHERE seq > $1 ORDER BY seq LIMIT $2`, [after, batch])).rows);
      if (!rows.length) return;
      for (const r of rows) {
        after = Number(r.seq);
        yield { event_id: r.event_id, event_type: r.event_type, schema_version: r.schema_version, tenant_id: r.tenant_id, brand_id: r.brand_id, player_id: r.player_id,
          occurred_at: new Date(r.occurred_at).toISOString(), received_at: new Date(r.received_at).toISOString(), source: r.source, correlation_id: r.correlation_id, payload: r.payload } as EventEnvelope;
      }
    }
  }
}

export class PgAuditStore {
  #db: Db;
  constructor(db: Db) { this.#db = db; }
  async append(e: AuditEntry): Promise<void> {
    await withTenant(this.#db, e.tenant_id, (c) => c.query(
      `INSERT INTO audit_log (seq, tenant_id, at, actor, action, subject, details, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (seq) DO NOTHING`,
      [e.seq, e.tenant_id, e.at, e.actor, e.action, e.subject, JSON.stringify(e.details), e.prev_hash, e.hash]));
  }
  /** Inserta en orden; RLS obliga a agrupar tramos contiguos del mismo tenant. */
  async appendMany(es: AuditEntry[]): Promise<void> {
    for (let i = 0; i < es.length;) {
      let j = i;
      while (j < es.length && es[j].tenant_id === es[i].tenant_id && j - i < 500) j++;
      const vals: unknown[] = [];
      const rows = es.slice(i, j).map((e, k) => {
        const o = k * 9;
        vals.push(e.seq, e.tenant_id, e.at, e.actor, e.action, e.subject, JSON.stringify(e.details), e.prev_hash, e.hash);
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9})`;
      });
      await withTenant(this.#db, es[i].tenant_id, (c) => c.query(`INSERT INTO audit_log (seq, tenant_id, at, actor, action, subject, details, prev_hash, hash) VALUES ${rows.join(',')} ON CONFLICT (seq) DO NOTHING`, vals));
      i = j;
    }
  }
  /** Último eslabón para continuar la cadena tras reiniciar. */
  async last(maintenance: Db): Promise<{ seq: number; hash: string } | null> {
    const r = (await maintenance.query('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1')).rows[0];
    return r ? { seq: Number(r.seq), hash: r.hash } : null;
  }
  /**
   * Verifica la cadena completa (rol de mantenimiento, sin RLS): cada hash debe coincidir
   * con su contenido y con el anterior. Devuelve el primer seq roto, si lo hay.
   */
  async verify(maintenance: Db): Promise<{ ok: boolean; entries: number; broken_at?: number }> {
    const rows = (await maintenance.query('SELECT seq, tenant_id, at, actor, action, subject, details, prev_hash, hash FROM audit_log ORDER BY seq')).rows;
    let prev = 'genesis';
    for (const r of rows) {
      const base = { seq: Number(r.seq), at: new Date(r.at).toISOString(), tenant_id: r.tenant_id, actor: r.actor, action: r.action, subject: r.subject, details: r.details, prev_hash: r.prev_hash };
      if (r.prev_hash !== prev || sha256(JSON.stringify(base)) !== r.hash) return { ok: false, entries: rows.length, broken_at: base.seq };
      prev = r.hash;
    }
    return { ok: true, entries: rows.length };
  }
}

/**
 * Conecta la app a la base: cada evento aplicado y cada registro de auditoría se escriben
 * en orden, por lotes (se acumulan ~20 ms y se escribe un lote a la vez). En la fase 2 la
 * escritura pasa a ser previa al efecto (write-ahead) dentro de la transacción del módulo.
 */
export function attachPersistence(app: App, events: PgEventStore, audit: PgAuditStore, onError: (e: unknown) => void = (e) => console.error('[persistencia]', e)) {
  let evQ: EventEnvelope[] = [], auQ: AuditEntry[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const drain = async () => {
    const evs = evQ, aus = auQ; evQ = []; auQ = [];
    const byTenant = new Map<string, EventEnvelope[]>();
    for (const e of evs) { const l = byTenant.get(e.tenant_id); if (l) l.push(e); else byTenant.set(e.tenant_id, [e]); }
    for (const [t, es] of byTenant) await events.appendMany(t, es);
    await audit.appendMany(aus);
  };
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; chain = chain.then(drain).catch(onError); }, 20);
  };
  // todo evento nuevo se guarda (también la carga histórica por CSV); los reconstruidos desde la base, no
  app.ingestor.subscribe((e, _p, meta) => { if (!meta.fromStore) { evQ.push(e); schedule(); } });
  (app.audit as AuditLog).listeners.push((entry) => { auQ.push(entry); schedule(); });
  return {
    /** Espera a que todo lo encolado quede escrito. */
    flush: async () => {
      while (timer || evQ.length || auQ.length) {
        if (timer) { clearTimeout(timer); timer = null; }
        chain = chain.then(drain).catch(onError);
        await chain;
      }
      await chain;
    },
    get pending() { return evQ.length + auQ.length; },
  };
}

/** Reconstruye perfiles y métricas desde el registro, sin efectos (sin recorridos, envíos ni bonos). */
export async function rebuildFromStore(app: App, store: PgEventStore, tenants: string[]): Promise<{ events: number }> {
  let n = 0;
  for (const t of tenants) for await (const e of store.stream(t)) { app.ingestor.ingest(e, { replay: true, fromStore: true }); n++; }
  return { events: n };
}

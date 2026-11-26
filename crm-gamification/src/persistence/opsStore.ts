/**
 * Persistencia de operación (Fase 2, incremento 3): versiones de recorridos, instancias, recibos de
 * entrega e historial de reprocesos. Todo corre con RLS (`withTenant`).
 *
 * Reglas:
 *  · Las escrituras son upserts idempotentes por llave natural (instance_id, idempotency_key).
 *  · El bloqueo de reproceso vive en la fila del recibo (`reprocess_lock_*`), con vencimiento: dos
 *    procesos (o dos réplicas de la web) no reprocesan la misma falla a la vez.
 *  · Un recibo `requested` al arrancar significa que el proceso cayó durante la llamada al proveedor:
 *    pasa a `uncertain` y entra a la cola para conciliarse, nunca se reenvía a ciegas.
 *  · Un solo worker activo a la vez (bloqueo consultivo `acquireWorkerLock`): dos workers no despiertan la misma espera.
 */
import type { Receipt } from '../channels/channels.ts';
import type { ReprocessAttempt } from '../channels/failures.ts';
import type { JourneyDefinition } from '../journeys/model.ts';
import type { InstanceRecord } from '../journeys/runtime.ts';
import { withTenant, type Db } from './db.ts';

const WORKER_LOCK = 7_302_2026;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : undefined);

export class PgOpsStore {
  #db: Db;
  constructor(db: Db) { this.#db = db; }

  async upsertVersions(tenant: string, defs: JourneyDefinition[]): Promise<void> {
    if (!defs.length) return;
    await withTenant(this.#db, tenant, async (c) => {
      for (const d of defs) await c.query(
        `INSERT INTO journey_versions (tenant_id, journey_id, version, status, definition, created_by, approved_by, approval_signature, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
         ON CONFLICT (tenant_id, journey_id, version) DO UPDATE SET status = EXCLUDED.status, definition = EXCLUDED.definition,
           approved_by = EXCLUDED.approved_by, approval_signature = EXCLUDED.approval_signature, updated_at = now()`,
        [tenant, d.id, d.version, d.status, JSON.stringify(d), d.created_by, d.approved_by ?? null, d.approval_signature ?? null]);
    });
  }

  async upsertInstances(tenant: string, xs: InstanceRecord[]): Promise<void> {
    if (!xs.length) return;
    await withTenant(this.#db, tenant, async (c) => {
      for (const i of xs) await c.query(
        `INSERT INTO journey_instances (instance_id, tenant_id, player_id, journey_id, version, arm, status, current_node, wake_at, trigger_event_id, correlation_id, trace, entered_at, trigger_payload, deferred_node, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
         ON CONFLICT (instance_id) DO UPDATE SET status = EXCLUDED.status, current_node = EXCLUDED.current_node, wake_at = EXCLUDED.wake_at,
           trace = EXCLUDED.trace, deferred_node = EXCLUDED.deferred_node, updated_at = now()`,
        [i.instance_id, tenant, i.player_id, i.journey_id, i.version, i.arm, i.status, i.current, i.wake_at ?? null, i.trigger_event_id, i.correlation_id,
          JSON.stringify(i.trace), i.trace[0]?.at ?? new Date().toISOString(), i.trigger_payload ? JSON.stringify(i.trigger_payload) : null, i.deferred_node ?? null]);
    });
  }

  async upsertReceipts(tenant: string, rs: Receipt[]): Promise<void> {
    if (!rs.length) return;
    await withTenant(this.#db, tenant, async (c) => {
      for (const r of rs) await c.query(
        `INSERT INTO delivery_receipts (idempotency_key, tenant_id, player_id, channel, template, locale, status, reason, provider_message_id, attempts, at,
           address, vars, rendered, journey_id, journey_version, instance_id, node_id, purpose, trigger_event_id, provider_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,now())
         ON CONFLICT (idempotency_key) DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason, provider_message_id = EXCLUDED.provider_message_id,
           attempts = EXCLUDED.attempts, at = EXCLUDED.at, rendered = COALESCE(EXCLUDED.rendered, delivery_receipts.rendered),
           vars = COALESCE(EXCLUDED.vars, delivery_receipts.vars), address = COALESCE(EXCLUDED.address, delivery_receipts.address),
           provider_at = COALESCE(EXCLUDED.provider_at, delivery_receipts.provider_at), updated_at = now()`,
        [r.idempotency_key, tenant, r.player_id, r.channel, r.template, r.locale, r.status, r.reason ?? null, r.provider_message_id ?? null, r.attempts, r.at,
          r.address ?? null, r.vars ? JSON.stringify(r.vars) : null, r.rendered ? JSON.stringify(r.rendered) : null,
          r.origin?.journey_id ?? null, r.origin?.version ?? null, r.origin?.instance_id ?? null, r.origin?.node_id ?? null, r.origin?.purpose ?? null, r.origin?.trigger_event_id ?? null, r.provider_at ?? null]);
    });
  }

  async appendAttempt(tenant: string, key: string, a: ReprocessAttempt, original?: { reason: string; status: string }): Promise<void> {
    await withTenant(this.#db, tenant, (c) => c.query(
      `INSERT INTO reprocess_attempts (tenant_id, idempotency_key, at, actor, reason, outcome, detail, original_reason, original_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenant, key, a.at, a.actor, a.reason, a.outcome, a.detail, original?.reason ?? null, original?.status ?? null]));
  }

  /** Bloqueo de reproceso en la base. Devuelve false si otro proceso ya la tiene o ya no es una falla. */
  async claimReprocess(tenant: string, key: string, actor: string, leaseSeconds = 120): Promise<boolean> {
    return withTenant(this.#db, tenant, async (c) => (await c.query(
      `UPDATE delivery_receipts SET reprocess_lock_by = $2, reprocess_lock_at = now()
       WHERE idempotency_key = $1 AND status IN ('failed','uncertain')
         AND (reprocess_lock_by IS NULL OR reprocess_lock_at < now() - make_interval(secs => $3))
       RETURNING idempotency_key`, [key, actor, leaseSeconds])).rowCount === 1);
  }
  async releaseReprocess(tenant: string, key: string): Promise<void> {
    await withTenant(this.#db, tenant, (c) => c.query('UPDATE delivery_receipts SET reprocess_lock_by = NULL, reprocess_lock_at = NULL WHERE idempotency_key = $1', [key]));
  }

  /** Al arrancar el worker: lo que quedó «requested» se vuelve «uncertain» (se concilia antes de reenviar). */
  async markInterrupted(tenant: string): Promise<number> {
    return withTenant(this.#db, tenant, async (c) => (await c.query(
      `UPDATE delivery_receipts SET status = 'uncertain', reason = 'interrupted_before_provider_response', updated_at = now() WHERE status = 'requested'`)).rowCount ?? 0);
  }

  /**
   * Un solo worker activo: el que obtiene el bloqueo consultivo. Los demás quedan en espera y lo
   * toman si el activo cae (la conexión que lo sostiene se cierra con el proceso).
   */
  async acquireWorkerLock(): Promise<{ held: boolean; release: () => Promise<void> }> {
    const c = await this.#db.connect();
    const held = (await c.query('SELECT pg_try_advisory_lock($1) AS ok', [WORKER_LOCK])).rows[0].ok === true;
    if (!held) c.release();
    return { held, release: async () => { if (held) { await c.query('SELECT pg_advisory_unlock($1)', [WORKER_LOCK]).catch(() => undefined); c.release(); } } };
  }

  async loadVersions(tenant: string, since?: string): Promise<JourneyDefinition[]> {
    return withTenant(this.#db, tenant, async (c) => (await c.query(
      `SELECT definition, status FROM journey_versions WHERE ($1::timestamptz IS NULL OR updated_at >= $1) ORDER BY journey_id, version`, [since ?? null])).rows
      .map((r) => ({ ...r.definition, status: r.status }) as JourneyDefinition));
  }

  async loadInstances(tenant: string, since?: string): Promise<InstanceRecord[]> {
    return withTenant(this.#db, tenant, async (c) => (await c.query(
      `SELECT * FROM journey_instances WHERE ($1::timestamptz IS NULL OR updated_at >= $1) ORDER BY entered_at, instance_id`, [since ?? null])).rows.map((r) => ({
      instance_id: r.instance_id, tenant_id: r.tenant_id, player_id: r.player_id, journey_id: r.journey_id, version: r.version, arm: r.arm, status: r.status,
      current: r.current_node, ...(r.wake_at ? { wake_at: iso(r.wake_at) } : {}), trigger_event_id: r.trigger_event_id, correlation_id: r.correlation_id, trace: r.trace,
      ...(r.trigger_payload ? { trigger_payload: r.trigger_payload } : {}), ...(r.deferred_node ? { deferred_node: r.deferred_node } : {}),
    }) as InstanceRecord));
  }

  async loadReceipts(tenant: string, since?: string): Promise<Receipt[]> {
    return withTenant(this.#db, tenant, async (c) => (await c.query(
      `SELECT * FROM delivery_receipts WHERE ($1::timestamptz IS NULL OR updated_at >= $1) ORDER BY at, idempotency_key`, [since ?? null])).rows.map((r) => ({
      idempotency_key: r.idempotency_key, tenant_id: r.tenant_id, player_id: r.player_id, channel: r.channel, template: r.template, locale: r.locale, status: r.status,
      ...(r.reason ? { reason: r.reason } : {}), ...(r.provider_message_id ? { provider_message_id: r.provider_message_id } : {}), attempts: r.attempts, at: iso(r.at)!,
      ...(r.address ? { address: r.address } : {}), ...(r.vars ? { vars: r.vars } : {}), ...(r.rendered ? { rendered: r.rendered } : {}),
      ...(r.journey_id ? { origin: { journey_id: r.journey_id, version: r.journey_version, instance_id: r.instance_id, node_id: r.node_id, purpose: r.purpose ?? 'marketing', ...(r.trigger_event_id ? { trigger_event_id: r.trigger_event_id } : {}) } } : {}),
      ...(r.provider_at ? { provider_at: iso(r.provider_at) } : {}),
    }) as Receipt));
  }

  async loadAttempts(tenant: string, since?: string): Promise<{ key: string; attempt: ReprocessAttempt; original?: { reason: string; status: Receipt['status'] } }[]> {
    return withTenant(this.#db, tenant, async (c) => (await c.query(
      `SELECT * FROM reprocess_attempts WHERE ($1::timestamptz IS NULL OR at >= $1) ORDER BY at, id`, [since ?? null])).rows.map((r) => ({
      key: r.idempotency_key, attempt: { at: iso(r.at)!, actor: r.actor, reason: r.reason, outcome: r.outcome, detail: r.detail },
      ...(r.original_status ? { original: { reason: r.original_reason ?? '', status: r.original_status } } : {}),
    })));
  }

  async now(): Promise<string> { return new Date((await this.#db.query('SELECT now() AS t')).rows[0].t).toISOString(); }
}

import { NON_PLAYER_EVENTS, validateEnvelope, type EventEnvelope } from '../domain/events.ts';
import { applyEvent, emptyProfile, type PlayerProfile } from '../profile/projection.ts';
import type { Clock } from '../shared/util.ts';

export type IngestResult = { status: 'applied' | 'duplicate' | 'rejected'; reason?: string; profile?: PlayerProfile };
/** `replay`: reprocesamiento histórico; los suscriptores no deben producir efectos externos. */
/** `fromStore`: el evento viene del registro persistido (reconstrucción): no se vuelve a guardar. */
export type IngestMeta = { replay: boolean; fromStore?: boolean };
export type Subscriber = (e: EventEnvelope, profile: PlayerProfile | undefined, meta: IngestMeta) => void;

const key = (tenant: string, player: string) => `${tenant}::${player}`;

/**
 * Consumidor idempotente (at-least-once): dedup por (tenant, event_id),
 * proyección por tenant/jugador, cola de errores y métricas de completitud por fuente.
 */
export class Ingestor {
  #profiles = new Map<string, PlayerProfile>();
  #seen = new Set<string>();
  #dlq: { event: unknown; reason: string; at: string }[] = [];
  #bySource = new Map<string, { received: number; applied: number; duplicates: number; rejected: number; max_lag_ms: number }>();
  #subs: Subscriber[] = [];
  /** B4: últimas mediciones (ms reales de proceso hasta decidir; retraso de llegada en tiempo de evento). */
  #lat = new Map<string, { type: string; ms: number; lag_ms: number }[]>(); // por tenant: un tenant no desplaza a otro
  latencyWindow = 5000;
  #clock: Clock;
  constructor(clock: Clock) { this.#clock = clock; }

  subscribe(fn: Subscriber): void { this.#subs.push(fn); }

  ingest(raw: unknown, opts: { replay?: boolean; fromStore?: boolean } = {}): IngestResult {
    const meta: IngestMeta = { replay: opts.replay ?? false, ...(opts.fromStore ? { fromStore: true } : {}) };
    const now = this.#clock.now();
    const src = String((raw as Record<string, unknown>)?.source ?? 'unknown');
    const m = this.#bySource.get(src) ?? { received: 0, applied: 0, duplicates: 0, rejected: 0, max_lag_ms: 0 };
    this.#bySource.set(src, m);
    m.received++;
    try {
      validateEnvelope(raw);
    } catch (err) {
      m.rejected++;
      this.#dlq.push({ event: raw, reason: (err as Error).message, at: now.toISOString() });
      return { status: 'rejected', reason: (err as Error).message };
    }
    const e: EventEnvelope = { ...raw, received_at: raw.received_at ?? now.toISOString() };
    const dedupKey = `${e.tenant_id}::${e.event_id}`;
    if (this.#seen.has(dedupKey)) { m.duplicates++; return { status: 'duplicate', profile: this.get(e.tenant_id, e.player_id) }; }
    this.#seen.add(dedupKey);
    m.max_lag_ms = Math.max(m.max_lag_ms, Date.parse(e.received_at!) - Date.parse(e.occurred_at));
    if (NON_PLAYER_EVENTS.includes(e.event_type)) {
      m.applied++;
      for (const s of this.#subs) s(e, undefined, meta);
      return { status: 'applied' };
    }
    const t0 = globalThis.performance?.now() ?? Date.now();
    const k = key(e.tenant_id, e.player_id);
    const profile = applyEvent(this.#profiles.get(k) ?? emptyProfile(e.tenant_id, e.brand_id, e.player_id), e);
    this.#profiles.set(k, profile);
    m.applied++;
    for (const s of this.#subs) s(e, profile, meta);
    if (!meta.replay) {
      // proyección + políticas + recorridos + efectos de este evento (incluye eventos derivados)
      const buf = this.#lat.get(e.tenant_id) ?? [];
      buf.push({ type: e.event_type, ms: (globalThis.performance?.now() ?? Date.now()) - t0, lag_ms: Math.max(0, Date.parse(e.received_at!) - Date.parse(e.occurred_at)) });
      if (buf.length > this.latencyWindow) buf.splice(0, buf.length - this.latencyWindow);
      this.#lat.set(e.tenant_id, buf);
    }
    return { status: 'applied', profile };
  }

  get(tenant_id: string, player_id: string): PlayerProfile | undefined { return this.#profiles.get(key(tenant_id, player_id)); }
  all(tenant_id: string): PlayerProfile[] { return [...this.#profiles.values()].filter((p) => p.tenant_id === tenant_id); }
  deadLetters() { return [...this.#dlq]; }
  sourceMetrics() { return Object.fromEntries(this.#bySource); }
  /** Percentiles de latencia evento→decisión en la ventana reciente, total y por tipo. */
  latency(tenant: string) {
    const xs = this.#lat.get(tenant) ?? [];
    const pct = (vals: number[], q: number) => { if (!vals.length) return null; const s = [...vals].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] * 100) / 100; };
    const sum = (ys: typeof xs) => ({ n: ys.length, p50_ms: pct(ys.map((y) => y.ms), 0.5), p95_ms: pct(ys.map((y) => y.ms), 0.95), p99_ms: pct(ys.map((y) => y.ms), 0.99), max_ms: ys.length ? Math.round(Math.max(...ys.map((y) => y.ms)) * 100) / 100 : null, lag_p95_ms: pct(ys.map((y) => y.lag_ms), 0.95) });
    const types = [...new Set(xs.map((x) => x.type))];
    return { ...sum(xs), by_type: Object.fromEntries(types.map((t) => [t, sum(xs.filter((x) => x.type === t))])), window: this.latencyWindow };
  }
  /** Cambia con cada evento aplicado: sirve para invalidar cachés derivados (modelos). */
  get version() { return this.#seen.size; }
}

import { NON_PLAYER_EVENTS, validateEnvelope, type EventEnvelope } from '../domain/events.ts';
import { applyEvent, emptyProfile, type PlayerProfile } from '../profile/projection.ts';
import type { Clock } from '../shared/util.ts';

export type IngestResult = { status: 'applied' | 'duplicate' | 'rejected'; reason?: string; profile?: PlayerProfile };
export type Subscriber = (e: EventEnvelope, profile: PlayerProfile | undefined) => void;

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
  #clock: Clock;
  constructor(clock: Clock) { this.#clock = clock; }

  subscribe(fn: Subscriber): void { this.#subs.push(fn); }

  ingest(raw: unknown): IngestResult {
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
      for (const s of this.#subs) s(e, undefined);
      return { status: 'applied' };
    }
    const k = key(e.tenant_id, e.player_id);
    const profile = applyEvent(this.#profiles.get(k) ?? emptyProfile(e.tenant_id, e.brand_id, e.player_id), e);
    this.#profiles.set(k, profile);
    m.applied++;
    for (const s of this.#subs) s(e, profile);
    return { status: 'applied', profile };
  }

  get(tenant_id: string, player_id: string): PlayerProfile | undefined { return this.#profiles.get(key(tenant_id, player_id)); }
  all(tenant_id: string): PlayerProfile[] { return [...this.#profiles.values()].filter((p) => p.tenant_id === tenant_id); }
  deadLetters() { return [...this.#dlq]; }
  sourceMetrics() { return Object.fromEntries(this.#bySource); }
}

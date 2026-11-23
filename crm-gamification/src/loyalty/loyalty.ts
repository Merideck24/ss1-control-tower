import type { EventEnvelope } from '../domain/events.ts';
import { DomainError, type Clock } from '../shared/util.ts';

export type Level = { name: string; threshold: number };
export type LoyaltyProgram = { tenant_id: string; brand_id: string; season: string; levels: Level[]; points_per_major_unit: number; halfway_notice: boolean };
export type LedgerEntry = { entry_id: string; tenant_id: string; player_id: string; season: string; points: number; reason: string; ref: string; compensates?: string; at: string };

export type Progress = { season: string; points: number; level: string; next_level: string | null; percent_to_next: number; points_to_next: number };

/**
 * Libro de movimientos propio de fidelidad (append-only). Idempotente por ref.
 * Reversos = asiento compensatorio, nunca edición (CRM-10).
 */
export class LoyaltyService {
  #programs = new Map<string, LoyaltyProgram>();
  #ledger: LedgerEntry[] = [];
  #balances = new Map<string, number>(); // tenant::player::season → saldo acumulado
  #refs = new Set<string>();
  #notified = new Set<string>(); // tenant::player::season::level
  #optOut = new Set<string>();
  #clock: Clock;
  onThreshold?: (e: EventEnvelope<'loyalty.threshold_crossed'>) => void;
  constructor(clock: Clock) { this.#clock = clock; }

  setProgram(p: LoyaltyProgram): void {
    const sorted = [...p.levels].sort((a, b) => a.threshold - b.threshold);
    if (sorted[0]?.threshold !== 0) throw new DomainError('invalid_program', 'first level must start at 0');
    this.#programs.set(`${p.tenant_id}::${p.brand_id}`, { ...p, levels: sorted });
  }
  program(tenant: string, brand: string) { return this.#programs.get(`${tenant}::${brand}`); }
  setOptOut(tenant: string, player: string, optOut: boolean) { const k = `${tenant}::${player}`; optOut ? this.#optOut.add(k) : this.#optOut.delete(k); }
  isOptedOut(tenant: string, player: string) { return this.#optOut.has(`${tenant}::${player}`); }

  balance(tenant: string, player: string, season: string): number {
    return this.#balances.get(`${tenant}::${player}::${season}`) ?? 0;
  }

  /** Cálculo del 50 %: entre el umbral del nivel actual y el siguiente. */
  progress(tenant: string, brand: string, player: string): Progress {
    const p = this.program(tenant, brand);
    if (!p) throw new DomainError('no_program', `${tenant}/${brand}`);
    const pts = Math.max(0, this.balance(tenant, player, p.season));
    let idx = 0;
    p.levels.forEach((l, i) => { if (pts >= l.threshold) idx = i; });
    const cur = p.levels[idx];
    const nxt = p.levels[idx + 1];
    const pct = nxt ? Math.floor(((pts - cur.threshold) / (nxt.threshold - cur.threshold)) * 100) : 100;
    return { season: p.season, points: pts, level: cur.name, next_level: nxt?.name ?? null, percent_to_next: pct, points_to_next: nxt ? nxt.threshold - pts : 0 };
  }

  #append(e: Omit<LedgerEntry, 'at'>, brand: string): LedgerEntry | undefined {
    if (this.#refs.has(`${e.tenant_id}::${e.ref}`)) return undefined;
    this.#refs.add(`${e.tenant_id}::${e.ref}`);
    const before = this.progress(e.tenant_id, brand, e.player_id);
    const entry = { ...e, at: this.#clock.now().toISOString() };
    this.#ledger.push(entry);
    const bk = `${e.tenant_id}::${e.player_id}::${e.season}`;
    this.#balances.set(bk, (this.#balances.get(bk) ?? 0) + e.points);
    const after = this.progress(e.tenant_id, brand, e.player_id);
    const crossedHalf = after.next_level && after.percent_to_next >= 50 && (before.level !== after.level || before.percent_to_next < 50);
    const nk = `${e.tenant_id}::${e.player_id}::${after.season}::${after.level}`;
    if (crossedHalf && this.program(e.tenant_id, brand)!.halfway_notice && !this.#notified.has(nk) && !this.isOptedOut(e.tenant_id, e.player_id)) {
      this.#notified.add(nk);
      this.onThreshold?.({
        event_id: `loyalty-50-${nk}`, event_type: 'loyalty.threshold_crossed', schema_version: 1, tenant_id: e.tenant_id, brand_id: brand, player_id: e.player_id,
        occurred_at: entry.at, source: 'ss1.loyalty', correlation_id: e.ref, payload: { level: after.next_level!, season: after.season, percent: after.percent_to_next },
      });
    }
    return entry;
  }

  /** Acumula desde eventos liquidados. Idempotente por event_id. */
  onEvent(e: EventEnvelope): LedgerEntry | undefined {
    const p = this.program(e.tenant_id, e.brand_id);
    if (!p || e.event_type !== 'bet.settled') return undefined;
    const stake = (e as EventEnvelope<'bet.settled'>).payload.stake.amount_minor;
    const points = Math.floor((stake / 100) * p.points_per_major_unit);
    if (points <= 0) return undefined;
    return this.#append({ entry_id: `le_${e.event_id}`, tenant_id: e.tenant_id, player_id: e.player_id, season: p.season, points, reason: 'bet.settled', ref: e.event_id }, e.brand_id);
  }

  /** Asiento compensatorio de un movimiento previo. */
  reverse(tenant: string, brand: string, ref: string, reason: string): LedgerEntry | undefined {
    const orig = this.#ledger.find((x) => x.tenant_id === tenant && x.ref === ref && !x.compensates);
    if (!orig) throw new DomainError('entry_not_found', ref);
    return this.#append({ entry_id: `le_rev_${ref}`, tenant_id: tenant, player_id: orig.player_id, season: orig.season, points: -orig.points, reason, ref: `reverse:${ref}`, compensates: orig.entry_id }, brand);
  }

  movements(tenant: string, player: string) { return this.#ledger.filter((e) => e.tenant_id === tenant && e.player_id === player); }
}

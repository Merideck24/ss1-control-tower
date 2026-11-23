import type { AuditLog } from '../audit/audit.ts';
import type { EventEnvelope, Money } from '../domain/events.ts';
import { DAY, DomainError, uuid, type Clock } from '../shared/util.ts';

export type RewardItem = {
  id: string;
  tenant_id: string;
  brand_id: string;
  reward_type: 'free_bet' | 'free_spins' | 'bonus';
  value: Money;
  validity_days: number;
  budget_minor: number; // presupuesto total
  approved_by?: string;
  /** Tope del escalado por conducta (G9). 1 = nunca sube; p. ej. 1.25 permite +25 % a jugadores valiosos. */
  max_multiplier?: number;
};

export type GrantStatus = 'reserved' | 'confirmed' | 'failed' | 'uncertain';
export type Grant = { grant_id: string; idempotency_key: string; tenant_id: string; player_id: string; reward_id: string; value: Money; status: GrantStatus; reason?: string; multiplier?: number; expires_at?: string; created_at: string };

/** Contrato con el servicio de bonos SS1 (wallet/bonos conserva saldos y otorgamientos). */
export interface BonusService {
  grant(req: { idempotency_key: string; tenant_id: string; player_id: string; reward_type: string; value: Money; expires_at: string }): { ok: true; bonus_ref: string } | { ok: false; reason: string; uncertain?: boolean };
  lookup(idempotency_key: string): { bonus_ref: string } | undefined;
  confirmed(tenant_id: string): string[]; // idempotency keys confirmadas
}

/** Mock del servicio de bonos: idempotente por clave; emite reward.granted al confirmar. */
export class MockBonusService implements BonusService {
  #grants = new Map<string, { tenant_id: string; bonus_ref: string }>();
  onGranted?: (e: EventEnvelope<'reward.granted'>) => void;
  timeoutNext = 0;
  #clock: Clock;
  constructor(clock: Clock) { this.#clock = clock; }
  grant(req: Parameters<BonusService['grant']>[0]) {
    const existing = this.#grants.get(req.idempotency_key);
    if (existing) return { ok: true as const, bonus_ref: existing.bonus_ref };
    const bonus_ref = `bon_${uuid().slice(0, 8)}`;
    this.#grants.set(req.idempotency_key, { tenant_id: req.tenant_id, bonus_ref });
    this.onGranted?.({
      event_id: `bonus-${req.idempotency_key}`, event_type: 'reward.granted', schema_version: 1, tenant_id: req.tenant_id, brand_id: 'rumbawin', player_id: req.player_id,
      occurred_at: this.#clock.now().toISOString(), source: 'ss1.bonus', correlation_id: req.idempotency_key,
      payload: { grant_id: bonus_ref, reward_type: req.reward_type as 'bonus', value: req.value, expires_at: req.expires_at },
    });
    if (this.timeoutNext > 0) { this.timeoutNext--; return { ok: false as const, reason: 'timeout', uncertain: true }; }
    return { ok: true as const, bonus_ref };
  }
  lookup(k: string) { const g = this.#grants.get(k); return g && { bonus_ref: g.bonus_ref }; }
  confirmed(tenant_id: string) { return [...this.#grants].filter(([, v]) => v.tenant_id === tenant_id).map(([k]) => k); }
}

/**
 * Catálogo + presupuesto con reserva transaccional y clave única (CRM-07).
 * Resultado incierto ⇒ conciliar con lookup antes de reintentar; nunca reenviar a ciegas.
 */
/** Compuerta de conducta (G9): multiplicador sugerido; 0 pausa el incentivo hasta revisión humana. */
export type RewardGate = (tenant: string, player: string) => { multiplier: number; reason: string } | undefined;

export class RewardService {
  #gate?: RewardGate;
  setGate(g: RewardGate) { this.#gate = g; }
  #catalog = new Map<string, RewardItem>();
  #grants = new Map<string, Grant>(); // idempotency_key → grant
  #spent = new Map<string, number>(); // reward_id → reserved+confirmed minor units
  #bonus: BonusService;
  #audit: AuditLog;
  #clock: Clock;
  constructor(bonus: BonusService, audit: AuditLog, clock: Clock) { this.#bonus = bonus; this.#audit = audit; this.#clock = clock; }

  addItem(item: RewardItem): void { this.#catalog.set(`${item.tenant_id}::${item.id}`, item); }
  item(tenant: string, id: string) { return this.#catalog.get(`${tenant}::${id}`); }
  catalog(tenant: string) { return [...this.#catalog.values()].filter((i) => i.tenant_id === tenant); }
  budget(tenant: string, id: string) { const i = this.item(tenant, id); return i ? { budget_minor: i.budget_minor, committed_minor: this.#spent.get(`${tenant}::${id}`) ?? 0, remaining_minor: i.budget_minor - (this.#spent.get(`${tenant}::${id}`) ?? 0) } : undefined; }

  grant(req: { tenant_id: string; player_id: string; reward_id: string; idempotency_key: string; actor: string }): Grant {
    const prior = this.#grants.get(req.idempotency_key);
    if (prior && prior.status !== 'uncertain') return prior;
    const item = this.item(req.tenant_id, req.reward_id);
    if (!item) throw new DomainError('reward_not_found', req.reward_id);
    if (!item.approved_by) throw new DomainError('reward_not_approved', req.reward_id);
    const bk = `${req.tenant_id}::${req.reward_id}`;
    let g = prior;
    if (!g) {
      // reserva atómica (single-threaded en memoria; en PostgreSQL: UPDATE … WHERE remaining >= value)
      const gate = this.#gate?.(req.tenant_id, req.player_id);
      const mult = gate ? Math.max(0, Math.min(gate.multiplier, item.max_multiplier ?? 1)) : 1;
      if (mult === 0) {
        g = { grant_id: uuid(), idempotency_key: req.idempotency_key, tenant_id: req.tenant_id, player_id: req.player_id, reward_id: item.id, value: item.value, status: 'failed', reason: 'abuse_review', created_at: this.#clock.now().toISOString() };
        this.#grants.set(req.idempotency_key, g);
        this.#audit.record(req.tenant_id, req.actor, 'reward.held_for_abuse_review', req.player_id, { reward_id: item.id, reason: gate!.reason });
        return g;
      }
      const value = { amount_minor: Math.round((item.value.amount_minor * mult) / 100) * 100, currency: item.value.currency };
      const committed = this.#spent.get(bk) ?? 0;
      if (committed + value.amount_minor > item.budget_minor) {
        g = { grant_id: uuid(), idempotency_key: req.idempotency_key, tenant_id: req.tenant_id, player_id: req.player_id, reward_id: item.id, value: item.value, status: 'failed', reason: 'budget_exhausted', created_at: this.#clock.now().toISOString() };
        this.#grants.set(req.idempotency_key, g);
        this.#audit.record(req.tenant_id, req.actor, 'reward.budget_exhausted', req.player_id, { reward_id: item.id });
        return g;
      }
      this.#spent.set(bk, committed + value.amount_minor);
      g = { grant_id: uuid(), idempotency_key: req.idempotency_key, tenant_id: req.tenant_id, player_id: req.player_id, reward_id: item.id, value, status: 'reserved', ...(mult !== 1 ? { multiplier: mult } : {}), expires_at: new Date(this.#clock.now().getTime() + item.validity_days * DAY).toISOString(), created_at: this.#clock.now().toISOString() };
      this.#grants.set(req.idempotency_key, g);
    } else {
      // estado incierto: conciliar antes de reenviar
      const found = this.#bonus.lookup(req.idempotency_key);
      if (found) { g.status = 'confirmed'; g.reason = `reconciled:${found.bonus_ref}`; return g; }
    }
    const res = this.#bonus.grant({ idempotency_key: req.idempotency_key, tenant_id: req.tenant_id, player_id: req.player_id, reward_type: item.reward_type, value: g.value, expires_at: g.expires_at! });
    if (res.ok) { g.status = 'confirmed'; g.reason = res.bonus_ref; }
    else if (res.uncertain) { g.status = 'uncertain'; g.reason = res.reason; }
    else { g.status = 'failed'; g.reason = res.reason; this.#spent.set(bk, (this.#spent.get(bk) ?? 0) - g.value.amount_minor); }
    this.#audit.record(req.tenant_id, req.actor, `reward.${g.status}`, req.player_id, { reward_id: item.id, idempotency_key: req.idempotency_key, reason: g.reason, amount_minor: g.value.amount_minor });
    return g;
  }

  /** Concilia otorgamientos locales con el servicio de bonos. */
  reconcile(tenant_id: string) {
    const remote = new Set(this.#bonus.confirmed(tenant_id));
    const local = [...this.#grants.values()].filter((g) => g.tenant_id === tenant_id);
    let resolved = 0;
    for (const g of local) if (g.status === 'uncertain' && remote.has(g.idempotency_key)) { g.status = 'confirmed'; resolved++; }
    const confirmedLocal = new Set(local.filter((g) => g.status === 'confirmed').map((g) => g.idempotency_key));
    return {
      matched: [...confirmedLocal].filter((k) => remote.has(k)).length,
      missing_in_bonus_service: [...confirmedLocal].filter((k) => !remote.has(k)),
      unknown_to_crm: [...remote].filter((k) => !confirmedLocal.has(k) && !local.some((g) => g.idempotency_key === k)),
      resolved_uncertain: resolved,
    };
  }

  grants(tenant: string) { return [...this.#grants.values()].filter((g) => g.tenant_id === tenant); }
}

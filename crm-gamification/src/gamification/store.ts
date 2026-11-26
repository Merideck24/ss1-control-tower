/**
 * Tienda de canjes (G6) y juegos de predicción (G7).
 * Monedas con libro propio (append-only). Canje: reserva de saldo y stock en una sección crítica por
 * artículo, idempotente por solicitud; si la entrega falla, asientos compensatorios (monedas y stock).
 * En PostgreSQL: UPDATE ... SET stock = stock - 1 WHERE stock > 0 y saldo con restricción, en la misma transacción.
 * Predicciones: gratuitas, una elección inmutable antes del cierre, resolución por aprobador, pagos idempotentes.
 */
import type { AuditLog } from '../audit/audit.ts';
import type { EventEnvelope } from '../domain/events.ts';
import type { LoyaltyService } from '../loyalty/loyalty.ts';
import type { PolicyEngine } from '../policy/policyEngine.ts';
import type { PlayerProfile } from '../profile/projection.ts';
import type { RewardService } from '../rewards/rewards.ts';
import { DomainError, type Clock } from '../shared/util.ts';

type Deps = { clock: Clock; audit: AuditLog; loyalty: LoyaltyService; rewards: RewardService; policy: PolicyEngine; profile: (t: string, p: string) => PlayerProfile | undefined };
const blocked = (d: Deps, p: PlayerProfile | undefined) => !p || d.loyalty.isOptedOut(p.tenant_id, p.player_id) || (!!p.rg && p.rg.value !== 'none');

export type CoinEntry = { id: string; player_id: string; amount: number; reason: string; ref: string; at: string };
export type StoreItem = { id: string; tenant_id: string; name: string; price_coins: number; stock: number; per_player_limit: number; reward: { reward_id?: string; xp?: number; physical?: string }; active: boolean };
export type Redemption = { request_id: string; tenant_id: string; player_id: string; item_id: string; price: number; status: 'fulfilled' | 'refunded'; reason?: string; at: string };

export type Prediction = {
  id: string; tenant_id: string; brand_id: string; name: string; question: string; options: string[]; closes_at: string;
  reward: { coins?: number; xp?: number }; status: 'open' | 'resolved'; created_by: string; resolved_option?: string; resolved_by?: string; payouts?: number;
};

export class StoreService {
  #d: Deps;
  #coins = new Map<string, CoinEntry[]>(); // tenant::player
  #coinRefs = new Set<string>();
  #items = new Map<string, StoreItem>();
  #redemptions = new Map<string, Redemption>(); // tenant|request
  #locks = new Map<string, Promise<unknown>>();
  #predictions = new Map<string, Prediction>();
  #picks = new Map<string, Map<string, { option: string; at: string }>>(); // tenant::prediction → player → pick
  coinRateMinor = 100_000; // 1 moneda por cada COP 1.000 apostados
  constructor(d: Deps) { this.#d = d; }

  // ---- monedas ----
  balance(tenant: string, player: string) { return (this.#coins.get(`${tenant}::${player}`) ?? []).reduce((s, e) => s + e.amount, 0); }
  ledger(tenant: string, player: string) { return [...(this.#coins.get(`${tenant}::${player}`) ?? [])]; }
  #post(tenant: string, player: string, amount: number, reason: string, ref: string): CoinEntry | undefined {
    const rk = `${tenant}::${ref}`;
    if (this.#coinRefs.has(rk)) return undefined; // idempotente por referencia
    this.#coinRefs.add(rk);
    const e = { id: `c_${ref}`, player_id: player, amount, reason, ref, at: this.#d.clock.now().toISOString() };
    const k = `${tenant}::${player}`;
    this.#coins.set(k, [...(this.#coins.get(k) ?? []), e]);
    return e;
  }
  onEvent(e: EventEnvelope, p: PlayerProfile | undefined) {
    if (e.event_type !== 'bet.settled' || blocked(this.#d, p)) return;
    const stake = (e as EventEnvelope<'bet.settled'>).payload.stake.amount_minor;
    const coins = Math.sign(stake) * Math.floor(Math.abs(stake) / this.coinRateMinor);
    if (coins > 0) this.#post(e.tenant_id, e.player_id, coins, 'bet.settled', `earn:${e.event_id}`);
    // reversión: se descuenta lo ganado por esa apuesta, sin dejar el saldo negativo (si ya las gastó, se descuenta lo que queda)
    else if (coins < 0) { const take = Math.min(-coins, this.balance(e.tenant_id, e.player_id)); if (take > 0) this.#post(e.tenant_id, e.player_id, -take, 'bet.rollback', `earn:${e.event_id}`); }
  }
  adjust(actor: { id: string; tenant_id: string }, player: string, amount: number, reason: string, ref: string) {
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000) throw new DomainError('invalid_amount', 'monto inválido');
    if (!reason || reason.length < 5) throw new DomainError('invalid_reason', 'motivo obligatorio');
    if (amount < 0 && this.balance(actor.tenant_id, player) + amount < 0) throw new DomainError('insufficient_coins', 'saldo insuficiente');
    const e = this.#post(actor.tenant_id, player, amount, `ajuste: ${reason.slice(0, 120)}`, `adjust:${ref}`);
    this.#d.audit.record(actor.tenant_id, actor.id, 'coins.adjusted', player, { amount, reason, duplicate: !e });
    return { balance: this.balance(actor.tenant_id, player), entry: e ?? null };
  }

  // ---- catálogo ----
  saveItem(actor: { id: string; tenant_id: string }, it: Omit<StoreItem, 'tenant_id'>): StoreItem {
    if (!/^[\w-]{3,48}$/.test(it.id) || !(it.price_coins > 0) || !(it.stock >= 0) || !(it.per_player_limit >= 1)) throw new DomainError('invalid_item', 'artículo inválido');
    if (!it.reward.reward_id && !it.reward.xp && !it.reward.physical) throw new DomainError('invalid_item', 'artículo sin recompensa');
    if (it.reward.reward_id && !this.#d.rewards.item(actor.tenant_id, it.reward.reward_id)) throw new DomainError('invalid_item', `bono ${it.reward.reward_id} no existe`);
    const out = { ...structuredClone(it), tenant_id: actor.tenant_id };
    this.#items.set(`${actor.tenant_id}::${it.id}`, out);
    this.#d.audit.record(actor.tenant_id, actor.id, 'store.item_saved', it.id, { price: it.price_coins, stock: it.stock });
    return out;
  }
  items(tenant: string) { return [...this.#items.values()].filter((i) => i.tenant_id === tenant); }
  redemptions(tenant: string, player?: string) { return [...this.#redemptions.values()].filter((r) => r.tenant_id === tenant && (!player || r.player_id === player)); }

  /** Sección crítica por artículo: los canjes del mismo artículo se serializan. */
  async #withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const cur = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => cur);
    this.#locks.set(key, tail);
    await prev;
    try { return await fn(); } finally { release(); if (this.#locks.get(key) === tail) this.#locks.delete(key); }
  }

  async redeem(tenant: string, player: string, itemId: string, requestId: string): Promise<Redemption> {
    if (!requestId) throw new DomainError('invalid_request', 'request_id obligatorio');
    const key = `${tenant}|${requestId}`;
    return this.#withLock(`${tenant}::${itemId}`, async () => {
      const prev = this.#redemptions.get(key); if (prev) return prev; // idempotente
      const item = this.#items.get(`${tenant}::${itemId}`);
      const p = this.#d.profile(tenant, player);
      if (!item || !item.active) throw new DomainError('not_found', itemId);
      if (blocked(this.#d, p)) throw new DomainError('not_eligible', 'jugador con gamificación desactivada o restricción de juego responsable');
      if (item.stock <= 0) throw new DomainError('out_of_stock', 'sin stock');
      if (this.balance(tenant, player) < item.price_coins) throw new DomainError('insufficient_coins', 'saldo insuficiente');
      if (this.redemptions(tenant, player).filter((r) => r.item_id === itemId && r.status === 'fulfilled').length >= item.per_player_limit) throw new DomainError('limit_reached', 'límite por jugador alcanzado');
      // reserva atómica: saldo y stock
      item.stock -= 1;
      this.#post(tenant, player, -item.price_coins, `canje:${itemId}`, `redeem:${requestId}`);
      let status: Redemption['status'] = 'fulfilled'; let reason: string | undefined;
      if (item.reward.reward_id) {
        const d = this.#d.policy.decide({ profile: p!, purpose: 'marketing', incentive: true });
        if (d.kind !== 'allow') { status = 'refunded'; reason = `suppressed:${d.reasons.join(',')}`; }
        else { const g = this.#d.rewards.grant({ tenant_id: tenant, player_id: player, reward_id: item.reward.reward_id, idempotency_key: `store:${requestId}`, actor: `store:${itemId}` }); if (g.status !== 'confirmed') { status = 'refunded'; reason = g.reason ?? g.status; } }
      }
      if (status === 'fulfilled' && item.reward.xp) this.#d.loyalty.award(tenant, p!.brand_id, player, item.reward.xp, `store:${itemId}`, `store:${requestId}`);
      if (status === 'refunded') { item.stock += 1; this.#post(tenant, player, item.price_coins, `reembolso:${itemId}`, `refund:${requestId}`); }
      const r: Redemption = { request_id: requestId, tenant_id: tenant, player_id: player, item_id: itemId, price: item.price_coins, status, ...(reason ? { reason } : {}), at: this.#d.clock.now().toISOString() };
      this.#redemptions.set(key, r);
      this.#d.audit.record(tenant, `player:${player}`, 'store.redeemed', itemId, { status, reason: reason ?? null, request_id: requestId });
      return r;
    });
  }

  // ---- predicciones ----
  savePrediction(actor: { id: string; tenant_id: string }, pr: Omit<Prediction, 'tenant_id' | 'status' | 'created_by' | 'resolved_option' | 'resolved_by' | 'payouts'>): Prediction {
    if (!/^[\w-]{3,48}$/.test(pr.id) || pr.options.length < 2 || new Set(pr.options).size !== pr.options.length) throw new DomainError('invalid_prediction', 'opciones inválidas');
    if (!pr.reward.coins && !pr.reward.xp) throw new DomainError('invalid_prediction', 'sin recompensa');
    const out: Prediction = { ...structuredClone(pr), tenant_id: actor.tenant_id, status: 'open', created_by: actor.id };
    this.#predictions.set(`${actor.tenant_id}::${pr.id}`, out);
    this.#d.audit.record(actor.tenant_id, actor.id, 'prediction.saved', pr.id, {});
    return out;
  }
  predictions(tenant: string) { return [...this.#predictions.values()].filter((x) => x.tenant_id === tenant); }
  picks(tenant: string, id: string) { return this.#picks.get(`${tenant}::${id}`) ?? new Map(); }
  pick(tenant: string, id: string, player: string, option: string) {
    const pr = this.#predictions.get(`${tenant}::${id}`);
    if (!pr || pr.status !== 'open') throw new DomainError('not_open', 'predicción cerrada o inexistente');
    if (this.#d.clock.now().toISOString() >= pr.closes_at) throw new DomainError('closed', 'la predicción ya cerró');
    if (!pr.options.includes(option)) throw new DomainError('invalid_option', option);
    if (blocked(this.#d, this.#d.profile(tenant, player))) throw new DomainError('not_eligible', 'jugador no elegible');
    const m = this.#picks.get(`${tenant}::${id}`) ?? new Map(); this.#picks.set(`${tenant}::${id}`, m);
    if (m.has(player)) throw new DomainError('already_picked', 'la elección no se puede cambiar');
    m.set(player, { option, at: this.#d.clock.now().toISOString() });
    return { player_id: player, option };
  }
  resolve(actor: { id: string; tenant_id: string }, id: string, option: string): Prediction {
    const pr = this.#predictions.get(`${actor.tenant_id}::${id}`);
    if (!pr) throw new DomainError('not_found', id);
    if (pr.status === 'resolved') return pr; // idempotente
    if (!pr.options.includes(option)) throw new DomainError('invalid_option', option);
    if (this.#d.clock.now().toISOString() < pr.closes_at) throw new DomainError('not_closed', 'aún no cierra');
    let payouts = 0;
    for (const [player, pk] of this.picks(actor.tenant_id, id)) {
      if (pk.option !== option) continue;
      const p = this.#d.profile(actor.tenant_id, player);
      if (blocked(this.#d, p)) continue;
      if (pr.reward.coins) this.#post(actor.tenant_id, player, pr.reward.coins, `prediccion:${id}`, `pred:${id}:${player}`);
      if (pr.reward.xp) this.#d.loyalty.award(actor.tenant_id, p!.brand_id, player, pr.reward.xp, `prediction:${id}`, `pred:${id}:${player}`);
      payouts++;
    }
    pr.status = 'resolved'; pr.resolved_option = option; pr.resolved_by = actor.id; pr.payouts = payouts;
    this.#d.audit.record(actor.tenant_id, actor.id, 'prediction.resolved', id, { option, payouts });
    return pr;
  }
}

/**
 * Regalos instantáneos: una campaña entrega un regalo (XP, monedas o un bono del catálogo) a jugadores
 * concretos o a un segmento.
 *
 * Ciclo: borrador → enviado → aprobado por otra persona (firma sobre el contenido) → activo → cerrado.
 * Al aprobar, la asignación es determinista: los destinatarios se ordenan por id y se asignan hasta el
 * cupo; quien no es elegible en ese momento queda fuera con su motivo (no recibe nada ni aviso).
 *
 * Reclamación: el jugador abre «Mis regalos» y reclama. Es única aunque lleguen dos solicitudes a la vez:
 * el estado cambia en una sola sección crítica y el efecto usa una clave idempotente por regalo y
 * jugador (el libro durable y el servicio de bonos la rechazan si se repite, también entre réplicas).
 * Antes de entregar se revalida juego responsable y política; si no cumple, el regalo queda «en pausa»
 * con el motivo y se puede reclamar cuando se resuelva, dentro de la vigencia. Vencido: «vencido».
 */
import type { AuditLog } from '../audit/audit.ts';
import { canonical } from '../journeys/registry.ts';
import type { LoyaltyService } from '../loyalty/loyalty.ts';
import type { PolicyEngine } from '../policy/policyEngine.ts';
import type { PlayerProfile } from '../profile/projection.ts';
import type { RewardService } from '../rewards/rewards.ts';
import { evaluate, type RuleNode } from '../segments/segmentEngine.ts';
import { DomainError, sha256, type Clock } from '../shared/util.ts';
import type { RealtimeHub } from './realtime.ts';
import { LOSS_CHASING, rgIneligibility } from './safeguards.ts';
import type { StoreService } from './store.ts';

export type GiftStatus = 'draft' | 'pending_approval' | 'active' | 'closed';
export type Gift = {
  id: string; tenant_id: string; brand_id: string; name: string; message: string;
  reward: { xp?: number; coins?: number; reward_id?: string };
  audience: { players?: string[]; segment?: RuleNode };
  max_recipients: number; expires_at: string;
  status: GiftStatus; created_by: string; approved_by?: string; approval_signature?: string; close_reason?: string;
  created_at: string; updated_at: string;
  assignment?: { at: string; assigned: number; skipped: Record<string, number> };
};
export type GiftClaimState = 'available' | 'claimed' | 'held' | 'expired' | 'revoked';
export type GiftAssignment = {
  gift_id: string; tenant_id: string; player_id: string; status: GiftClaimState; assigned_at: string;
  claimed_at?: string; held_reason?: string; idempotency_key: string;
  reward?: { status: 'confirmed' | 'pending' | 'failed' | 'suppressed'; detail?: string; grant_id?: string };
};

export type GiftDeps = { clock: Clock; audit: AuditLog; loyalty: LoyaltyService; rewards: RewardService; store: StoreService; policy: PolicyEngine; realtime: RealtimeHub; profile: (t: string, p: string) => PlayerProfile | undefined; profiles: (t: string) => PlayerProfile[]; riskHold?: (t: string, p: string) => boolean };
type Actor = { id: string; tenant_id: string };
const signed = (g: Gift) => ({ id: g.id, reward: g.reward, audience: g.audience, max_recipients: g.max_recipients, expires_at: g.expires_at, brand_id: g.brand_id, message: g.message });
export const MAX_GIFT_RECIPIENTS = 50_000;

export class GiftService {
  #d: GiftDeps;
  #gifts = new Map<string, Gift>(); // tenant::id
  #asg = new Map<string, GiftAssignment>(); // tenant::gift::player
  onChange?: (x: { gifts?: Gift[]; assignments?: GiftAssignment[] }) => void;
  constructor(d: GiftDeps) { this.#d = d; }
  #now() { return this.#d.clock.now().toISOString(); }
  #emit(x: { gifts?: Gift[]; assignments?: GiftAssignment[] }) { this.onChange?.(x); }

  static validate(g: Partial<Gift>): string[] {
    const e: string[] = [];
    if (!/^[\w-]{3,48}$/.test(String(g.id ?? ''))) e.push('id: 3 a 48 letras, números, guion o guion bajo');
    if (!g.name || g.name.length < 3 || g.name.length > 80) e.push('nombre: 3 a 80 caracteres');
    if (!g.message || g.message.length < 3 || g.message.length > 200) e.push('mensaje: 3 a 200 caracteres');
    if (LOSS_CHASING.test(`${g.name ?? ''} ${g.message ?? ''}`)) e.push('juego responsable: un regalo no puede invitar a recuperar pérdidas');
    const r = g.reward ?? {};
    if (!r.xp && !r.coins && !r.reward_id) e.push('recompensa: XP, monedas o un bono del catálogo');
    if (r.xp !== undefined && !(Number.isInteger(r.xp) && r.xp > 0 && r.xp <= 100_000)) e.push('XP: entero entre 1 y 100.000');
    if (r.coins !== undefined && !(Number.isInteger(r.coins) && r.coins > 0 && r.coins <= 100_000)) e.push('monedas: entero entre 1 y 100.000');
    const a = g.audience ?? {};
    if (!a.players?.length && !a.segment) e.push('destinatarios: jugadores o un segmento');
    if (a.players && (!Array.isArray(a.players) || a.players.some((p) => !/^[\w-]{1,64}$/.test(String(p))))) e.push('destinatarios: ids de jugador inválidos');
    if (!(Number.isInteger(g.max_recipients) && g.max_recipients! >= 1 && g.max_recipients! <= MAX_GIFT_RECIPIENTS)) e.push(`cupo: entre 1 y ${MAX_GIFT_RECIPIENTS}`);
    if (!g.expires_at || Number.isNaN(Date.parse(g.expires_at))) e.push('vigencia: fecha de vencimiento');
    return e;
  }

  saveDraft(actor: Actor, input: Omit<Gift, 'tenant_id' | 'status' | 'created_by' | 'created_at' | 'updated_at'>): Gift {
    const errs = GiftService.validate(input);
    if (input.reward?.reward_id && !this.#d.rewards.item(actor.tenant_id, input.reward.reward_id)) errs.push(`bono ${input.reward.reward_id} no existe en el catálogo`);
    if (input.expires_at && Date.parse(input.expires_at) <= this.#d.clock.now().getTime()) errs.push('vigencia: debe vencer en el futuro');
    if (errs.length) throw new DomainError('invalid_gift', errs.join('; '));
    const prev = this.#gifts.get(`${actor.tenant_id}::${input.id}`);
    if (prev && prev.status !== 'draft' && prev.status !== 'pending_approval') throw new DomainError('immutable', 'Un regalo aprobado no se edita: crea otro.');
    const now = this.#now();
    const g: Gift = { ...structuredClone(input), audience: { ...(input.audience.players ? { players: [...new Set(input.audience.players)] } : {}), ...(input.audience.segment ? { segment: input.audience.segment } : {}) },
      tenant_id: actor.tenant_id, status: 'draft', created_by: actor.id, created_at: prev?.created_at ?? now, updated_at: now };
    this.#gifts.set(`${actor.tenant_id}::${g.id}`, g);
    this.#d.audit.record(actor.tenant_id, actor.id, 'gift.draft_saved', g.id, { reward: g.reward, max_recipients: g.max_recipients });
    this.#emit({ gifts: [g] });
    return g;
  }
  submit(actor: Actor, id: string): Gift {
    const g = this.#must(actor.tenant_id, id);
    if (g.status !== 'draft') throw new DomainError('invalid_state', `El regalo está en «${g.status}».`);
    g.status = 'pending_approval'; g.updated_at = this.#now();
    this.#d.audit.record(actor.tenant_id, actor.id, 'gift.submitted', id, {});
    this.#emit({ gifts: [g] });
    return g;
  }
  /** Aprueba (otra persona) y asigna en el mismo paso. */
  approve(actor: Actor, id: string): Gift {
    const g = this.#must(actor.tenant_id, id);
    if (g.status !== 'pending_approval') throw new DomainError('invalid_state', 'Solo se aprueba un regalo enviado.');
    if (g.created_by === actor.id) throw new DomainError('four_eyes', 'Quien crea el regalo no puede aprobarlo.');
    if (Date.parse(g.expires_at) <= this.#d.clock.now().getTime()) throw new DomainError('expired', 'El regalo ya venció.');
    g.approved_by = actor.id; g.approval_signature = sha256(canonical({ ...signed(g), approver: actor.id }));
    g.status = 'active'; g.updated_at = this.#now();
    const out = this.#assign(g);
    this.#d.audit.record(actor.tenant_id, actor.id, 'gift.approved', id, { signature: g.approval_signature, assigned: g.assignment!.assigned, skipped: g.assignment!.skipped });
    this.#emit({ gifts: [g], assignments: out });
    return g;
  }
  close(actor: Actor, id: string, reason: string): Gift {
    const g = this.#must(actor.tenant_id, id);
    if (!reason || reason.trim().length < 5) throw new DomainError('reason_required', 'Indica el motivo del cierre.');
    if (g.status === 'closed') return g;
    g.status = 'closed'; g.close_reason = reason; g.updated_at = this.#now();
    const changed: GiftAssignment[] = [];
    for (const a of this.assignments(actor.tenant_id, id)) if (a.status === 'available' || a.status === 'held') { a.status = 'revoked'; changed.push(a); this.#d.realtime.publish(a.tenant_id, a.player_id, 'gift.revoked', { gift_id: id }); }
    this.#d.audit.record(actor.tenant_id, actor.id, 'gift.closed', id, { reason, revoked: changed.length });
    this.#emit({ gifts: [g], assignments: changed });
    return g;
  }

  /** Motivos por los que el jugador no puede recibir o reclamar el regalo (vacío = puede). */
  ineligibility(g: Gift, p: PlayerProfile | undefined, at = this.#now()): string[] {
    if (!p) return ['player_not_found'];
    const r: string[] = [];
    if (p.brand_id !== g.brand_id) r.push('other_brand');
    r.push(...rgIneligibility({ loyalty: this.#d.loyalty, riskHold: this.#d.riskHold }, p, at));
    return r;
  }

  #assign(g: Gift): GiftAssignment[] {
    const t = g.tenant_id, at = this.#now();
    const ids = new Set<string>(g.audience.players ?? []);
    if (g.audience.segment) for (const p of this.#d.profiles(t)) if (evaluate(g.audience.segment, p, new Date(at))) ids.add(p.player_id);
    const sorted = [...ids].sort();
    const skipped: Record<string, number> = {};
    const out: GiftAssignment[] = [];
    for (const pid of sorted) {
      const why = this.ineligibility(g, this.#d.profile(t, pid), at);
      if (why.length) { skipped[why[0]] = (skipped[why[0]] ?? 0) + 1; continue; }
      if (out.length >= g.max_recipients) { skipped.over_capacity = (skipped.over_capacity ?? 0) + 1; continue; }
      const a: GiftAssignment = { gift_id: g.id, tenant_id: t, player_id: pid, status: 'available', assigned_at: at, idempotency_key: `gift:${t}:${g.id}:${pid}` };
      this.#asg.set(`${t}::${g.id}::${pid}`, a); out.push(a);
      this.#d.realtime.publish(t, pid, 'gift.received', { gift_id: g.id, name: g.name, message: g.message, reward: g.reward, expires_at: g.expires_at });
    }
    g.assignment = { at, assigned: out.length, skipped };
    return out;
  }

  /** Reclamación única: el cambio de estado y el efecto ocurren en un solo paso sincrónico. */
  claim(tenant: string, player: string, id: string): GiftAssignment {
    const g = this.#gifts.get(`${tenant}::${id}`);
    const a = this.#asg.get(`${tenant}::${id}::${player}`);
    if (!g || !a) throw new DomainError('not_found', 'No tienes ese regalo.');
    if (a.status === 'claimed') return a; // repetir no duplica
    if (a.status === 'revoked' || g.status === 'closed') throw new DomainError('revoked', 'Este regalo ya no está disponible.');
    if (Date.parse(g.expires_at) < this.#d.clock.now().getTime()) { a.status = 'expired'; this.#emit({ assignments: [a] }); throw new DomainError('expired', 'El regalo venció.'); }
    const p = this.#d.profile(tenant, player)!;
    const why = this.ineligibility(g, p);
    const d = this.#d.policy.decide({ profile: p, purpose: 'marketing', incentive: true });
    if (why.length || (g.reward.reward_id && d.kind !== 'allow')) {
      a.status = 'held'; a.held_reason = why[0] ?? d.reasons.join(',');
      this.#d.audit.record(tenant, `player:${player}`, 'gift.held', id, { reason: a.held_reason });
      this.#d.realtime.publish(tenant, player, 'gift.held', { gift_id: id, reason: a.held_reason });
      this.#emit({ assignments: [a] });
      return a;
    }
    a.status = 'claimed'; a.claimed_at = this.#now(); a.held_reason = undefined;
    if (g.reward.xp) this.#d.loyalty.award(tenant, p.brand_id, player, g.reward.xp, `gift:${id}`, a.idempotency_key);
    if (g.reward.coins) this.#d.store.adjust({ id: `gift:${id}`, tenant_id: tenant }, player, g.reward.coins, `regalo: ${g.name}`, a.idempotency_key);
    if (g.reward.reward_id) {
      const r = this.#d.rewards.grant({ tenant_id: tenant, player_id: player, reward_id: g.reward.reward_id, idempotency_key: a.idempotency_key, actor: `gift:${id}` });
      a.reward = { status: r.status === 'confirmed' ? 'confirmed' : r.status === 'failed' ? 'failed' : 'pending', detail: r.reason, grant_id: r.grant_id };
    } else a.reward = { status: 'confirmed', detail: 'xp/monedas en el libro del CRM' };
    this.#d.audit.record(tenant, `player:${player}`, 'gift.claimed', id, { reward: a.reward.status });
    this.#d.realtime.publish(tenant, player, 'reward.status', { gift_id: id, status: a.reward.status, detail: a.reward.detail ?? null });
    this.#emit({ assignments: [a] });
    return a;
  }

  /** Vencidos: los regalos sin reclamar pasan a «vencido» y la campaña se cierra. */
  tick(): number {
    const now = this.#d.clock.now().getTime(); let n = 0;
    for (const g of this.#gifts.values()) {
      if (g.status !== 'active' || Date.parse(g.expires_at) >= now) continue;
      g.status = 'closed'; g.close_reason = 'fin de vigencia'; g.updated_at = this.#now(); n++;
      const changed = this.assignments(g.tenant_id, g.id).filter((a) => a.status === 'available' || a.status === 'held');
      for (const a of changed) a.status = 'expired';
      this.#emit({ gifts: [g], assignments: changed });
    }
    return n;
  }

  #rewardNow(tenant: string, a: GiftAssignment) {
    if (a.reward?.status !== 'pending') return a.reward;
    const r = this.#d.rewards.grants(tenant).find((x) => x.idempotency_key === a.idempotency_key);
    if (r?.status === 'confirmed' || r?.status === 'failed') a.reward = { ...a.reward, status: r.status };
    return a.reward;
  }
  #must(t: string, id: string) { const g = this.#gifts.get(`${t}::${id}`); if (!g) throw new DomainError('not_found', `No existe el regalo ${id}.`); return g; }
  get(t: string, id: string) { return this.#gifts.get(`${t}::${id}`); }
  list(t: string) { return [...this.#gifts.values()].filter((g) => g.tenant_id === t); }
  assignments(t: string, id?: string) { return [...this.#asg.values()].filter((a) => a.tenant_id === t && (!id || a.gift_id === id)); }

  /** «Mis regalos»: los asignados al jugador, con su estado (sin regalos de otros jugadores). */
  mine(t: string, player: string) {
    return [...this.#asg.values()].filter((a) => a.tenant_id === t && a.player_id === player).map((a) => {
      const g = this.#gifts.get(`${t}::${a.gift_id}`)!;
      const expired = a.status === 'available' && Date.parse(g.expires_at) < this.#d.clock.now().getTime();
      return { gift_id: g.id, name: g.name, message: g.message, reward: g.reward, expires_at: g.expires_at, status: expired ? 'expired' : a.status, held_reason: a.held_reason ?? null, claimed_at: a.claimed_at ?? null, reward_state: this.#rewardNow(t, a) ?? null };
    }).sort((x, y) => (x.status === 'available' ? 0 : 1) - (y.status === 'available' ? 0 : 1) || x.expires_at.localeCompare(y.expires_at));
  }

  stats(t: string) {
    return this.list(t).map((g) => {
      const as = this.assignments(t, g.id);
      const claimed = as.filter((a) => a.status === 'claimed');
      const rs = claimed.map((a) => this.#rewardNow(t, a));
      return { id: g.id, name: g.name, status: g.status, brand_id: g.brand_id, reward: g.reward, expires_at: g.expires_at, created_by: g.created_by, approved_by: g.approved_by ?? null,
        assigned: as.length, claimed: claimed.length, claim_rate: as.length ? claimed.length / as.length : null,
        held: as.filter((a) => a.status === 'held').length, expired: as.filter((a) => a.status === 'expired').length, revoked: as.filter((a) => a.status === 'revoked').length,
        rewards_confirmed: rs.filter((r) => r?.status === 'confirmed').length, rewards_pending: rs.filter((r) => r?.status === 'pending').length,
        skipped: g.assignment?.skipped ?? {} };
    });
  }

  restore(x: { gifts?: Gift[]; assignments?: GiftAssignment[] }) {
    for (const g of x.gifts ?? []) this.#gifts.set(`${g.tenant_id}::${g.id}`, g);
    for (const a of x.assignments ?? []) {
      const k = `${a.tenant_id}::${a.gift_id}::${a.player_id}`;
      const cur = this.#asg.get(k);
      // un regalo ya reclamado aquí no vuelve a «disponible» por una copia más vieja
      if (cur?.status === 'claimed' && a.status !== 'claimed') continue;
      this.#asg.set(k, a);
    }
  }
}

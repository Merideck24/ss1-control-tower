/**
 * Misiones (G2) y logros (G3).
 * - Progreso idempotente por evento; reversos de depósito corrigen el progreso (CRM-10).
 * - Recompensa en XP (libro de fidelidad) o bono del catálogo (pasa por política y presupuesto).
 * - Misiones con bono requieren aprobación de otra persona.
 * - Sin participación si el jugador desactivó la gamificación (G10) o tiene restricción de juego responsable.
 */
import type { AuditLog } from '../audit/audit.ts';
import type { EventEnvelope } from '../domain/events.ts';
import type { LoyaltyService } from '../loyalty/loyalty.ts';
import type { PolicyEngine } from '../policy/policyEngine.ts';
import type { PlayerProfile } from '../profile/projection.ts';
import type { RewardService } from '../rewards/rewards.ts';
import { evaluate, type RuleNode } from '../segments/segmentEngine.ts';
import { DomainError, type Clock } from '../shared/util.ts';

export type MissionKind = 'count' | 'sum' | 'streak';
export type Mission = {
  id: string; tenant_id: string; brand_id: string; name: string; description: string;
  kind: MissionKind; event_type: 'bet.settled' | 'deposit.settled'; product?: 'casino' | 'sports';
  target: number; // count: eventos; sum: unidades mínimas; streak: días seguidos
  starts_at: string; ends_at: string; segment?: RuleNode;
  reward: { xp?: number; reward_id?: string };
  status: 'draft' | 'pending_approval' | 'active' | 'paused' | 'ended';
  created_by: string; approved_by?: string;
};
export type Progress = { mission_id: string; player_id: string; value: number; days: string[]; counted: string[]; deposits: Record<string, number>; completed_at?: string; reward_status?: string; disputed?: boolean };
export type GamificationDeps = { clock: Clock; audit: AuditLog; loyalty: LoyaltyService; rewards: RewardService; policy: PolicyEngine; profile: (t: string, p: string) => PlayerProfile | undefined };

export type Badge = { id: string; name: string; description: string; test: (ctx: BadgeCtx) => boolean };
type BadgeCtx = { profile: PlayerProfile; missionsCompleted: number; bestStreak: number; level: string | null };
export const BADGES: Badge[] = [
  { id: 'first_deposit', name: 'Primer depósito', description: 'Hizo su primer depósito', test: (c) => c.profile.stats.deposit_count >= 1 },
  { id: 'bets_100', name: 'Centenario', description: '100 apuestas liquidadas', test: (c) => c.profile.stats.bets_count >= 100 },
  { id: 'streak_7', name: 'Racha de 7 días', description: 'Jugó 7 días seguidos', test: (c) => c.bestStreak >= 7 },
  { id: 'missions_5', name: 'Cazador de misiones', description: 'Completó 5 misiones', test: (c) => c.missionsCompleted >= 5 },
  { id: 'level_silver', name: 'Nivel Plata', description: 'Alcanzó Plata o superior', test: (c) => !!c.level && c.level !== 'Bronce' },
  { id: 'level_gold', name: 'Nivel Oro', description: 'Alcanzó Oro o superior', test: (c) => c.level === 'Oro' || c.level === 'Platino' },
  { id: 'level_platinum', name: 'Nivel Platino', description: 'Alcanzó Platino', test: (c) => c.level === 'Platino' },
];

const DAYF = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' });
// memo por tramo de 15 min: exacto en cualquier zona (los desfases son múltiplos de 15 min) y evita miles de llamadas a Intl
const DAY_MEMO = new Map<number, string>();
const localDay = (iso: string) => {
  const k = Math.floor(Date.parse(iso) / 900_000);
  let d = DAY_MEMO.get(k);
  if (d === undefined) { d = DAYF.format(new Date(k * 900_000)); if (DAY_MEMO.size > 50_000) DAY_MEMO.clear(); DAY_MEMO.set(k, d); }
  return d;
};
const dayNum = (d: string) => Math.round(Date.parse(d + 'T12:00:00Z') / 86_400_000);
function streakEnding(days: string[], last: string): number { const set = new Set(days.map(dayNum)); let n = 0, d = dayNum(last); while (set.has(d)) { n++; d--; } return n; }
/** Racha más larga de días consecutivos, en una sola pasada (antes: cuadrático en días por evento). */
function longestStreak(days: Iterable<string>): number {
  const ns = [...new Set([...days].map(dayNum))].sort((a, b) => a - b);
  let best = 0, run = 0, prev = NaN;
  for (const n of ns) { run = n === prev + 1 ? run + 1 : 1; prev = n; if (run > best) best = run; }
  return best;
}

export class GamificationService {
  #missions = new Map<string, Mission>();
  #progress = new Map<string, Progress>(); // tenant::mission::player
  #badges = new Map<string, { id: string; at: string }[]>(); // tenant::player
  #activityDays = new Map<string, Set<string>>(); // tenant::player → días con actividad (para logros)
  #deps: GamificationDeps;
  constructor(deps: GamificationDeps) { this.#deps = deps; }

  // --- definición y ciclo de vida ---
  save(actor: { id: string; tenant_id: string }, m: Omit<Mission, 'status' | 'created_by' | 'approved_by' | 'tenant_id'>): Mission {
    if (!/^[\w-]{3,48}$/.test(m.id)) throw new DomainError('invalid_mission', 'id inválido');
    if (!(m.target > 0)) throw new DomainError('invalid_mission', 'target debe ser > 0');
    if (!m.reward.xp && !m.reward.reward_id) throw new DomainError('invalid_mission', 'requiere recompensa (xp o reward_id)');
    if (Date.parse(m.ends_at) <= Date.parse(m.starts_at)) throw new DomainError('invalid_mission', 'la ventana termina antes de empezar');
    if (m.reward.reward_id && !this.#deps.rewards.item(actor.tenant_id, m.reward.reward_id)) throw new DomainError('invalid_mission', `bono ${m.reward.reward_id} no existe`);
    const prev = this.#missions.get(`${actor.tenant_id}::${m.id}`);
    if (prev && prev.status !== 'draft') throw new DomainError('invalid_state', `La misión «${prev.id}» ya está ${({ pending_approval: 'en aprobación', active: 'activa', paused: 'en pausa', ended: 'terminada' } as Record<string, string>)[prev.status] ?? prev.status}: solo se editan borradores. Para una misión nueva usa otro id.`);
    const mission: Mission = { ...structuredClone(m), tenant_id: actor.tenant_id, status: 'draft', created_by: actor.id };
    this.#missions.set(`${actor.tenant_id}::${m.id}`, mission);
    this.#deps.audit.record(actor.tenant_id, actor.id, 'mission.draft_saved', m.id, { kind: m.kind, target: m.target, reward: m.reward });
    return mission;
  }
  /** Sin bono se activa directo; con bono pasa a aprobación y la activa otra persona. */
  activate(actor: { id: string; tenant_id: string; canApprove: boolean }, id: string): Mission {
    const m = this.get(actor.tenant_id, id);
    if (!m) throw new DomainError('not_found', id);
    if (m.reward.reward_id && m.status === 'paused' && m.approved_by) {
      // ya aprobada: reanudar no requiere otra aprobación (el contenido no cambió; editarla exige borrador nuevo)
      m.status = 'active';
      this.#deps.audit.record(m.tenant_id, actor.id, 'mission.resumed', id, { approved_by: m.approved_by });
      return m;
    }
    if (m.reward.reward_id) {
      if (m.status === 'draft') { m.status = 'pending_approval'; this.#deps.audit.record(m.tenant_id, actor.id, 'mission.submitted', id, {}); return m; }
      if (m.status !== 'pending_approval') throw new DomainError('invalid_state', m.status);
      if (!actor.canApprove) throw new DomainError('forbidden', 'requiere aprobador');
      if (m.created_by === actor.id) throw new DomainError('segregation_of_duties', 'el autor no puede aprobar su misión');
      m.approved_by = actor.id;
    } else if (m.status !== 'draft' && m.status !== 'paused') throw new DomainError('invalid_state', m.status);
    m.status = 'active';
    this.#deps.audit.record(m.tenant_id, actor.id, 'mission.activated', id, { approved_by: m.approved_by ?? null });
    return m;
  }
  pause(actor: { id: string; tenant_id: string }, id: string) {
    const m = this.get(actor.tenant_id, id);
    if (!m || m.status !== 'active') throw new DomainError('invalid_state', 'no activa');
    m.status = 'paused'; this.#deps.audit.record(m.tenant_id, actor.id, 'mission.paused', id, {});
    return m;
  }
  get(tenant: string, id: string) { return this.#missions.get(`${tenant}::${id}`); }
  list(tenant: string) { return [...this.#missions.values()].filter((m) => m.tenant_id === tenant); }

  // --- elegibilidad ---
  eligible(m: Mission, p: PlayerProfile, at: string): boolean {
    if (m.status !== 'active' || p.brand_id !== m.brand_id) return false;
    if (at < m.starts_at || at > m.ends_at) return false;
    if (this.#deps.loyalty.isOptedOut(p.tenant_id, p.player_id)) return false;
    if (p.rg && p.rg.value !== 'none') return false; // sin gamificación promocional con restricción JR
    if (m.segment && !evaluate(m.segment, p, new Date(at))) return false;
    return true;
  }

  // --- eventos ---
  onEvent(e: EventEnvelope, p: PlayerProfile | undefined) {
    if (!p) return;
    const stake = e.event_type === 'bet.settled' ? (e as EventEnvelope<'bet.settled'>).payload.stake.amount_minor : 0;
    // del admin de SS1 llegan movimientos sueltos: premio (stake 0) y reversión (stake negativo) no son apuestas
    if ((e.event_type === 'bet.settled' && stake > 0) || e.event_type === 'deposit.settled') {
      const k = `${e.tenant_id}::${e.player_id}`;
      const days = this.#activityDays.get(k) ?? new Set<string>(); days.add(localDay(e.occurred_at)); this.#activityDays.set(k, days);
    }
    for (const m of this.list(e.tenant_id)) {
      if (e.event_type === 'deposit.reversed' && m.event_type === 'deposit.settled') { this.#reverse(m, e as EventEnvelope<'deposit.reversed'>); continue; }
      if (m.event_type !== e.event_type || !this.eligible(m, p, e.occurred_at)) continue;
      if (m.product && (e as EventEnvelope<'bet.settled'>).payload.product !== m.product) continue;
      if (e.event_type === 'bet.settled' && stake <= 0 && m.kind !== 'sum') continue; // no suma rondas ni días de racha
      const key = `${e.tenant_id}::${m.id}::${e.player_id}`;
      const pr = this.#progress.get(key) ?? { mission_id: m.id, player_id: e.player_id, value: 0, days: [], counted: [], deposits: {} };
      if (pr.completed_at || pr.counted.includes(e.event_id)) continue;
      pr.counted.push(e.event_id);
      if (e.event_type === 'deposit.settled') { const d = (e as EventEnvelope<'deposit.settled'>).payload; pr.deposits[d.deposit_id] = d.amount_minor; }
      if (m.kind === 'count') pr.value += 1;
      else if (m.kind === 'sum') pr.value = Math.max(0, pr.value + (e.event_type === 'deposit.settled' ? (e as EventEnvelope<'deposit.settled'>).payload.amount_minor : stake)); // la reversión descuenta lo apostado
      else { const d = localDay(e.occurred_at); if (!pr.days.includes(d)) pr.days.push(d); pr.value = streakEnding(pr.days, d); }
      this.#progress.set(key, pr);
      if (pr.value >= m.target) this.#complete(m, pr, p);
    }
    this.#evaluateBadges(p);
  }

  /** Reverso de un depósito contado: asiento compensatorio en el progreso; si ya estaba completada, queda en revisión. */
  #reverse(m: Mission, e: EventEnvelope<'deposit.reversed'>) {
    const pr = this.#progress.get(`${e.tenant_id}::${m.id}::${e.player_id}`);
    const amount = pr?.deposits[e.payload.deposit_id];
    if (!pr || amount === undefined) return; // ese depósito no sumó en esta misión
    delete pr.deposits[e.payload.deposit_id];
    if (pr.completed_at) { pr.disputed = true; this.#deps.audit.record(e.tenant_id, 'system', 'mission.completion_disputed', e.player_id, { mission: m.id, deposit_id: e.payload.deposit_id }); return; }
    if (m.kind === 'sum') pr.value = Math.max(0, pr.value - amount);
    else if (m.kind === 'count') pr.value = Math.max(0, pr.value - 1);
  }

  #complete(m: Mission, pr: Progress, p: PlayerProfile) {
    pr.completed_at = this.#deps.clock.now().toISOString();
    const ref = `mission:${m.id}:${p.player_id}`;
    if (m.reward.xp) this.#deps.loyalty.award(p.tenant_id, p.brand_id, p.player_id, m.reward.xp, `mission:${m.id}`, ref);
    if (m.reward.reward_id) {
      const d = this.#deps.policy.decide({ profile: p, purpose: 'marketing', incentive: true });
      if (d.kind !== 'allow') pr.reward_status = `suppressed:${d.reasons.join(',')}`;
      else pr.reward_status = this.#deps.rewards.grant({ tenant_id: p.tenant_id, player_id: p.player_id, reward_id: m.reward.reward_id, idempotency_key: ref, actor: `mission:${m.id}` }).status;
    } else pr.reward_status = 'xp_awarded';
    this.#deps.audit.record(p.tenant_id, 'system', 'mission.completed', p.player_id, { mission: m.id, reward_status: pr.reward_status });
  }

  #evaluateBadges(p: PlayerProfile) {
    const k = `${p.tenant_id}::${p.player_id}`;
    if (this.#deps.loyalty.isOptedOut(p.tenant_id, p.player_id)) return;
    const have = this.#badges.get(k) ?? [];
    const best = longestStreak(this.#activityDays.get(k) ?? []);
    const prog = this.#deps.loyalty.program(p.tenant_id, p.brand_id) ? this.#deps.loyalty.progress(p.tenant_id, p.brand_id, p.player_id) : null;
    const ctx: BadgeCtx = { profile: p, missionsCompleted: this.playerMissions(p.tenant_id, p.player_id).filter((x) => x.completed_at).length, bestStreak: best, level: prog?.level ?? null };
    for (const b of BADGES) if (!have.some((h) => h.id === b.id) && b.test(ctx)) have.push({ id: b.id, at: this.#deps.clock.now().toISOString() });
    this.#badges.set(k, have);
  }

  playerMissions(tenant: string, player: string): Progress[] {
    return this.list(tenant).map((m) => this.#progress.get(`${tenant}::${m.id}::${player}`)).filter((x): x is Progress => !!x);
  }
  playerView(tenant: string, player: string) {
    const p = this.#deps.profile(tenant, player);
    const now = this.#deps.clock.now().toISOString();
    const missions = this.list(tenant).filter((m) => m.status === 'active' || this.#progress.has(`${tenant}::${m.id}::${player}`)).map((m) => {
      const pr = this.#progress.get(`${tenant}::${m.id}::${player}`);
      return { id: m.id, name: m.name, description: m.description, kind: m.kind, target: m.target, value: pr?.value ?? 0, completed_at: pr?.completed_at ?? null, reward: m.reward, reward_status: pr?.reward_status ?? null, ends_at: m.ends_at, eligible: p ? this.eligible(m, p, now) : false, disputed: pr?.disputed ?? false };
    });
    const badges = (this.#badges.get(`${tenant}::${player}`) ?? []).map((b) => ({ ...BADGES.find((x) => x.id === b.id)!, test: undefined, at: b.at }));
    return { opt_out: this.#deps.loyalty.isOptedOut(tenant, player), missions, badges, badge_catalog: BADGES.map((b) => ({ id: b.id, name: b.name, description: b.description })) };
  }
  stats(tenant: string) {
    return this.list(tenant).map((m) => {
      const prs = [...this.#progress.values()].filter((x) => x.mission_id === m.id && this.#progress.get(`${tenant}::${m.id}::${x.player_id}`) === x);
      const done = prs.filter((x) => x.completed_at);
      const item = m.reward.reward_id ? this.#deps.rewards.item(tenant, m.reward.reward_id) : undefined;
      return { ...m, segment: m.segment ?? null, participants: prs.length, completions: done.length, completion_rate: prs.length ? done.length / prs.length : null,
        reward_cost_minor: item ? done.filter((x) => x.reward_status === 'confirmed').length * item.value.amount_minor : 0, xp_awarded: (m.reward.xp ?? 0) * done.length, disputed: prs.filter((x) => x.disputed).length };
    });
  }
}

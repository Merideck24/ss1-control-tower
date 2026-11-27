/**
 * Retos (diarios, semanales y de temporada) con pasos individuales, secuenciales o múltiples.
 *
 * Ciclo de vida: borrador → enviado → aprobado por otra persona (firma sobre el contenido) → programado o
 * activo → en pausa → cerrado. Un cambio después de aprobar es una versión nueva; el jugador queda en la
 * versión con la que se inscribió durante el período.
 *
 * Participación voluntaria: el jugador se inscribe (y elige si recibe avisos). Progreso idempotente por
 * evento y período; los reversos compensan. Al completar: XP (libro de fidelidad), monedas o un bono del
 * catálogo. El bono queda «pendiente» hasta que el servicio de bonos lo confirma. Antes de otorgar se
 * revalida la política vigente.
 *
 * Juego responsable (salvaguardas de diseño, no opcionales):
 *  · Ningún paso puede premiar pérdidas ni pedir «recuperar»; los retos diarios no piden depósitos ni montos apostados.
 *  · No participa quien tiene restricción de juego responsable, un caso de riesgo abierto o una señal de riesgo
 *    reciente; si la señal llega durante el reto, la inscripción se suspende (sin progreso ni premio ni avisos).
 */
import type { AuditLog } from '../audit/audit.ts';
import type { EventEnvelope } from '../domain/events.ts';
import type { LoyaltyService } from '../loyalty/loyalty.ts';
import type { PolicyEngine } from '../policy/policyEngine.ts';
import type { PlayerProfile } from '../profile/projection.ts';
import type { RewardService } from '../rewards/rewards.ts';
import { canonical } from '../journeys/registry.ts';
import { evaluate, type RuleNode } from '../segments/segmentEngine.ts';
import { DomainError, sha256, type Clock } from '../shared/util.ts';
import type { AchievementService } from './achievements.ts';
import type { RealtimeHub } from './realtime.ts';
import type { StoreService } from './store.ts';

export type StepKind = 'count' | 'sum' | 'activity' | 'loyalty_level';
export type ChallengeStep = { id: string; label: string; kind: StepKind; event_type?: 'bet.settled' | 'deposit.settled'; product?: 'casino' | 'sports'; action?: 'profile_completed' | 'feature_visited' | 'preferences_saved'; feature?: string; level?: string; target: number };
export type Period = 'daily' | 'weekly' | 'season';
export type ChallengeStatus = 'draft' | 'pending_approval' | 'scheduled' | 'active' | 'paused' | 'closed';
export type Challenge = {
  id: string; tenant_id: string; brand_id: string; market?: string; segment?: RuleNode; season?: string;
  name: string; description: string; period: Period; mode: 'single' | 'sequential' | 'all'; steps: ChallengeStep[];
  reward: { xp?: number; coins?: number; reward_id?: string };
  starts_at: string; ends_at: string; timezone: string; max_participants?: number;
  status: ChallengeStatus; version: number; created_by: string; approved_by?: string; approval_signature?: string; updated_at: string; close_reason?: string;
};
export type RewardState = { status: 'pending' | 'confirmed' | 'suppressed' | 'failed' | 'reversed'; detail?: string; idempotency_key: string; grant_id?: string };
export type Enrollment = {
  challenge_id: string; version: number; player_id: string; tenant_id: string; enrolled_at: string; notify: boolean;
  status: 'active' | 'left' | 'suspended'; suspended_reason?: string;
  periods: Record<string, { steps: Record<string, number>; counted: string[]; deposits: Record<string, { step: string; amount: number }>; completed_at?: string; reward?: RewardState }>;
};

const DAY = 86_400_000;
const LOSS_CHASING = /recuper\w*\s+(\p{L}+\s+){0,2}(lo\s+)?(perdid|p[eé]rdid)|chase\s+(your\s+)?loss|recupera\w*\s+(tu|su)\s+dinero|vuelve\s+a\s+ganar\s+lo\s+perdido/iu;
const MAX_ACTIVE_ENROLLMENTS = 3;
const RISK_COOLDOWN_DAYS = 30;

function periodKey(c: Challenge, iso: string): string {
  if (c.period === 'season') return c.season ?? 'temporada';
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: c.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  if (c.period === 'daily') return day;
  // semana ISO (lunes a domingo) en la zona del reto
  const d = new Date(day + 'T12:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThu.getTime()) / DAY - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
const signed = (c: Challenge) => ({ id: c.id, version: c.version, steps: c.steps, reward: c.reward, period: c.period, mode: c.mode, starts_at: c.starts_at, ends_at: c.ends_at, segment: c.segment ?? null, market: c.market ?? null });

export type ChallengeDeps = { clock: Clock; audit: AuditLog; loyalty: LoyaltyService; rewards: RewardService; store: StoreService; policy: PolicyEngine; achievements: AchievementService; realtime: RealtimeHub; profile: (t: string, p: string) => PlayerProfile | undefined; riskHold?: (t: string, p: string) => boolean };

export class ChallengeService {
  #defs = new Map<string, Challenge[]>(); // tenant::id → versiones
  #enroll = new Map<string, Enrollment>(); // tenant::challenge::player
  #d: ChallengeDeps;
  /** Persistencia: definiciones e inscripciones que cambiaron. */
  onChange?: (x: { challenges?: Challenge[]; enrollments?: Enrollment[] }) => void;
  constructor(d: ChallengeDeps) { this.#d = d; }
  #now() { return this.#d.clock.now().toISOString(); }
  #emit(x: { challenges?: Challenge[]; enrollments?: Enrollment[] }) { this.onChange?.(x); }

  // ───────── definición ─────────
  static validate(c: Omit<Challenge, 'tenant_id' | 'status' | 'version' | 'created_by' | 'updated_at'>): string[] {
    const e: string[] = [];
    if (!/^[\w-]{3,48}$/.test(c.id ?? '')) e.push('El identificador debe tener de 3 a 48 letras, números, guion o guion bajo.');
    if (!c.name?.trim()) e.push('Falta el nombre.');
    if (!['daily', 'weekly', 'season'].includes(c.period)) e.push('El período debe ser diario, semanal o de temporada.');
    if (!['single', 'sequential', 'all'].includes(c.mode)) e.push('El modo debe ser individual, secuencial o de varios pasos.');
    if (!Array.isArray(c.steps) || !c.steps.length) e.push('El reto necesita al menos un paso.');
    if (c.mode === 'single' && c.steps?.length > 1) e.push('Un reto individual tiene un solo paso.');
    if (!(Date.parse(c.ends_at) > Date.parse(c.starts_at))) e.push('La fecha de fin debe ser posterior al inicio.');
    try { new Intl.DateTimeFormat('en', { timeZone: c.timezone }); } catch { e.push('Zona horaria inválida.'); }
    if (!c.reward || !(c.reward.xp || c.reward.coins || c.reward.reward_id)) e.push('El reto necesita una recompensa (XP, monedas o un bono del catálogo).');
    if (LOSS_CHASING.test(`${c.name} ${c.description} ${(c.steps ?? []).map((s) => s.label).join(' ')}`)) e.push('Juego responsable: un reto no puede invitar a recuperar pérdidas.');
    const ids = new Set<string>();
    for (const s of c.steps ?? []) {
      if (!s.id || ids.has(s.id)) e.push(`Paso con identificador vacío o repetido: «${s.id ?? ''}».`); ids.add(s.id);
      if (!(s.target > 0)) e.push(`El paso «${s.label}» necesita una meta mayor que cero.`);
      if ((s.kind === 'count' || s.kind === 'sum') && !s.event_type) e.push(`El paso «${s.label}» necesita el evento que cuenta.`);
      if (s.kind === 'activity' && !s.action) e.push(`El paso «${s.label}» necesita la acción del jugador.`);
      if (s.kind === 'loyalty_level' && !s.level) e.push(`El paso «${s.label}» necesita el nivel de fidelidad.`);
      if (c.period === 'daily' && (s.event_type === 'deposit.settled' || s.kind === 'sum')) e.push(`Juego responsable: un reto diario no puede pedir depósitos ni montos apostados («${s.label}»).`);
    }
    return e;
  }

  saveDraft(actor: { id: string; tenant_id: string }, input: Omit<Challenge, 'tenant_id' | 'status' | 'version' | 'created_by' | 'updated_at' | 'approved_by' | 'approval_signature'>): Challenge {
    const errs = ChallengeService.validate(input);
    if (input.reward?.reward_id && !this.#d.rewards.item(actor.tenant_id, input.reward.reward_id)) errs.push(`El bono «${input.reward.reward_id}» no existe en el catálogo.`);
    if (errs.length) throw new DomainError('invalid_challenge', errs.join(' '));
    const k = `${actor.tenant_id}::${input.id}`;
    const vs = this.#defs.get(k) ?? [];
    const last = vs.at(-1);
    if (last && last.status === 'pending_approval') throw new DomainError('invalid_state', 'Hay una versión en aprobación: espera la decisión antes de editar.');
    const version = last ? (last.status === 'draft' ? last.version : last.version + 1) : 1;
    if (last?.status === 'draft') vs.pop();
    const c: Challenge = { ...structuredClone(input), tenant_id: actor.tenant_id, status: 'draft', version, created_by: actor.id, updated_at: this.#now() };
    vs.push(c); this.#defs.set(k, vs);
    this.#d.audit.record(actor.tenant_id, actor.id, 'challenge.draft_saved', `${c.id}@v${version}`, { period: c.period, mode: c.mode, steps: c.steps.length, reward: c.reward });
    this.#emit({ challenges: [c] });
    return c;
  }
  #latest(tenant: string, id: string) { const c = this.#defs.get(`${tenant}::${id}`)?.at(-1); if (!c) throw new DomainError('not_found', `No existe el reto ${id}.`); return c; }
  submit(actor: { id: string; tenant_id: string }, id: string): Challenge {
    const c = this.#latest(actor.tenant_id, id);
    if (c.status !== 'draft') throw new DomainError('invalid_state', 'Solo se envía un borrador.');
    c.status = 'pending_approval'; c.updated_at = this.#now();
    this.#d.audit.record(actor.tenant_id, actor.id, 'challenge.submitted', `${id}@v${c.version}`, {});
    this.#emit({ challenges: [c] });
    return c;
  }
  approve(actor: { id: string; tenant_id: string }, id: string): Challenge {
    const c = this.#latest(actor.tenant_id, id);
    if (c.status !== 'pending_approval') throw new DomainError('invalid_state', 'No hay una versión en aprobación.');
    if (c.created_by === actor.id) throw new DomainError('segregation_of_duties', 'Quien crea el reto no puede aprobarlo.');
    c.approved_by = actor.id;
    c.approval_signature = sha256(canonical({ ...signed(c), approver: actor.id }));
    c.status = Date.parse(c.starts_at) > this.#d.clock.now().getTime() ? 'scheduled' : 'active';
    c.updated_at = this.#now();
    // la versión anterior activa deja de admitir inscripciones nuevas; quien ya estaba sigue en la suya hasta fin del período
    for (const v of this.#defs.get(`${actor.tenant_id}::${id}`) ?? []) if (v !== c && (v.status === 'active' || v.status === 'scheduled' || v.status === 'paused')) { v.status = 'closed'; v.close_reason = `reemplazada por v${c.version}`; }
    this.#d.audit.record(actor.tenant_id, actor.id, 'challenge.approved', `${id}@v${c.version}`, { signature: c.approval_signature, status: c.status });
    this.#emit({ challenges: this.#defs.get(`${actor.tenant_id}::${id}`) });
    return c;
  }
  setPaused(actor: { id: string; tenant_id: string }, id: string, paused: boolean): Challenge {
    const c = this.#latest(actor.tenant_id, id);
    if (paused ? c.status !== 'active' : c.status !== 'paused') throw new DomainError('invalid_state', paused ? 'Solo se pausa un reto activo.' : 'Solo se reanuda un reto en pausa.');
    c.status = paused ? 'paused' : 'active'; c.updated_at = this.#now();
    this.#d.audit.record(actor.tenant_id, actor.id, paused ? 'challenge.paused' : 'challenge.resumed', `${id}@v${c.version}`, {});
    this.#emit({ challenges: [c] });
    return c;
  }
  close(actor: { id: string; tenant_id: string }, id: string, reason: string): Challenge {
    if (!reason?.trim()) throw new DomainError('reason_required', 'Cerrar un reto exige un motivo.');
    const c = this.#latest(actor.tenant_id, id);
    if (c.status === 'closed') return c;
    c.status = 'closed'; c.close_reason = reason; c.updated_at = this.#now();
    this.#d.audit.record(actor.tenant_id, actor.id, 'challenge.closed', `${id}@v${c.version}`, { reason });
    this.#emit({ challenges: [c] });
    return c;
  }
  /** Programados cuya fecha llegó pasan a activos; vencidos se cierran. Lo llama el planificador. */
  tick(): number {
    let n = 0; const now = this.#d.clock.now().getTime();
    for (const vs of this.#defs.values()) for (const c of vs) {
      if (c.status === 'scheduled' && Date.parse(c.starts_at) <= now) { c.status = 'active'; n++; this.#emit({ challenges: [c] }); }
      if ((c.status === 'active' || c.status === 'paused') && Date.parse(c.ends_at) < now) { c.status = 'closed'; c.close_reason = 'fin de vigencia'; n++; this.#emit({ challenges: [c] }); }
    }
    return n;
  }
  get(tenant: string, id: string, version?: number) { const vs = this.#defs.get(`${tenant}::${id}`); return version ? vs?.find((v) => v.version === version) : vs?.at(-1); }
  list(tenant: string) { return [...this.#defs.values()].map((vs) => vs.at(-1)!).filter((c) => c.tenant_id === tenant); }
  versions(tenant: string, id: string) { return [...(this.#defs.get(`${tenant}::${id}`) ?? [])]; }

  // ───────── elegibilidad ─────────
  /** Motivos por los que el jugador no puede participar (vacío = puede). */
  ineligibility(c: Challenge, p: PlayerProfile | undefined, at = this.#now()): string[] {
    const r: string[] = [];
    if (!p) return ['player_not_found'];
    if (c.status !== 'active') r.push(c.status === 'scheduled' ? 'not_started' : 'not_active');
    if (p.brand_id !== c.brand_id) r.push('other_brand');
    if (at < c.starts_at || at > c.ends_at) r.push('outside_window');
    if (c.market && p.country?.value !== c.market) r.push('other_market');
    if (this.#d.loyalty.isOptedOut(p.tenant_id, p.player_id)) r.push('gamification_opt_out');
    if (!p.rg || p.rg.value !== 'none') r.push('rg_restricted');
    if (this.#d.riskHold?.(p.tenant_id, p.player_id)) r.push('rg_risk_case_open');
    if (p.risk && Date.parse(p.risk.occurred_at) > Date.parse(at) - RISK_COOLDOWN_DAYS * DAY) r.push('vulnerability_signal');
    if (c.segment && !evaluate(c.segment, p, new Date(at))) r.push('not_in_segment');
    return r;
  }

  // ───────── jugador ─────────
  enroll(tenant: string, player: string, id: string, notify: boolean): Enrollment {
    const c = this.get(tenant, id);
    if (!c) throw new DomainError('not_found', `No existe el reto ${id}.`);
    const p = this.#d.profile(tenant, player);
    const why = this.ineligibility(c, p);
    if (why.length) throw new DomainError('not_eligible', `No puedes inscribirte: ${why.join(', ')}.`);
    const k = `${tenant}::${id}::${player}`;
    const prev = this.#enroll.get(k);
    if (prev?.status === 'active') return prev; // repetir la inscripción no duplica
    const active = [...this.#enroll.values()].filter((e) => e.tenant_id === tenant && e.player_id === player && e.status === 'active' && this.get(tenant, e.challenge_id)?.status === 'active').length;
    if (active >= MAX_ACTIVE_ENROLLMENTS) throw new DomainError('limit_reached', `Puedes participar en hasta ${MAX_ACTIVE_ENROLLMENTS} retos a la vez.`);
    if (c.max_participants && [...this.#enroll.values()].filter((e) => e.tenant_id === tenant && e.challenge_id === id && e.status === 'active').length >= c.max_participants) throw new DomainError('full', 'El reto alcanzó su cupo.');
    const e: Enrollment = prev ? { ...prev, status: 'active', version: c.version, notify, suspended_reason: undefined } : { challenge_id: id, version: c.version, player_id: player, tenant_id: tenant, enrolled_at: this.#now(), notify, status: 'active', periods: {} };
    this.#enroll.set(k, e);
    this.#d.audit.record(tenant, player, 'challenge.enrolled', `${id}@v${c.version}`, { notify });
    // pasos que ya se cumplen al inscribirse (p. ej. nivel de fidelidad o perfil ya completo)
    if (p) this.#evaluateStatic(c, e, p);
    this.#emit({ enrollments: [e] });
    return e;
  }
  leave(tenant: string, player: string, id: string): Enrollment {
    const e = this.#enroll.get(`${tenant}::${id}::${player}`);
    if (!e) throw new DomainError('not_found', 'No estás inscrito en este reto.');
    e.status = 'left'; this.#d.audit.record(tenant, player, 'challenge.left', id, {});
    this.#emit({ enrollments: [e] });
    return e;
  }
  setNotify(tenant: string, player: string, id: string, notify: boolean): Enrollment {
    const e = this.#enroll.get(`${tenant}::${id}::${player}`);
    if (!e) throw new DomainError('not_found', 'No estás inscrito en este reto.');
    e.notify = notify; this.#emit({ enrollments: [e] });
    return e;
  }

  // ───────── eventos ─────────
  onEvent(e: EventEnvelope, p: PlayerProfile | undefined) {
    if (!p) return;
    // señal de riesgo o restricción de juego responsable: se suspenden las inscripciones activas
    if (e.event_type === 'rg.risk_signal' || (e.event_type === 'rg.status_changed' && (e as EventEnvelope<'rg.status_changed'>).payload.status !== 'none')) {
      for (const en of this.#mine(e.tenant_id, e.player_id)) if (en.status === 'active') {
        en.status = 'suspended'; en.suspended_reason = e.event_type === 'rg.risk_signal' ? 'vulnerability_signal' : 'rg_restricted';
        this.#d.audit.record(e.tenant_id, 'system', 'challenge.enrollment_suspended', e.player_id, { challenge: en.challenge_id, reason: en.suspended_reason });
        this.#d.realtime.publish(e.tenant_id, e.player_id, 'challenge.suspended', { challenge_id: en.challenge_id, reason: en.suspended_reason });
        this.#emit({ enrollments: [en] });
      }
      return;
    }
    if (e.event_type === 'player.activity') {
      const a = (e as EventEnvelope<'player.activity'>).payload;
      this.#d.achievements.recordActivity(e.tenant_id, p.brand_id, e.player_id, a.action, a.feature);
    }
    for (const en of this.#mine(e.tenant_id, e.player_id)) {
      if (en.status !== 'active') continue;
      const c = this.get(e.tenant_id, en.challenge_id, en.version);
      if (!c || c.status !== 'active' || e.occurred_at < c.starts_at || e.occurred_at > c.ends_at) continue;
      if (this.ineligibility(c, p, e.occurred_at).length) continue;
      const pk = periodKey(c, e.occurred_at);
      const per = (en.periods[pk] ??= { steps: {}, counted: [], deposits: {} });
      if (e.event_type === 'deposit.reversed') { this.#reverse(c, en, pk, e as EventEnvelope<'deposit.reversed'>, p); continue; }
      if (per.completed_at || per.counted.includes(e.event_id)) continue; // idempotente por evento y período
      let touched = false;
      for (const s of this.#openSteps(c, per)) {
        const d = this.#delta(s, e);
        if (d === 0) continue;
        per.steps[s.id] = Math.max(0, (per.steps[s.id] ?? 0) + d);
        if (e.event_type === 'deposit.settled' && d > 0) per.deposits[(e as EventEnvelope<'deposit.settled'>).payload.deposit_id] = { step: s.id, amount: d };
        touched = true;
        if (per.steps[s.id] >= s.target) this.#d.realtime.publish(e.tenant_id, e.player_id, 'challenge.step_done', { challenge_id: c.id, step_id: s.id, label: s.label });
        if (c.mode === 'sequential') break; // en secuencia solo avanza el paso en curso
      }
      if (!touched) continue;
      per.counted.push(e.event_id);
      this.#d.realtime.publish(e.tenant_id, e.player_id, 'challenge.progress', { challenge_id: c.id, period: pk, steps: per.steps });
      if (c.steps.every((s) => (per.steps[s.id] ?? 0) >= s.target)) this.#complete(c, en, pk, p);
      this.#emit({ enrollments: [en] });
    }
  }

  #mine(tenant: string, player: string) { return [...this.#enroll.values()].filter((x) => x.tenant_id === tenant && x.player_id === player); }
  #openSteps(c: Challenge, per: Enrollment['periods'][string]): ChallengeStep[] {
    const open = c.steps.filter((s) => (per.steps[s.id] ?? 0) < s.target);
    return c.mode === 'sequential' ? open.slice(0, 1) : open;
  }
  /** Cuánto suma un evento a un paso (0 = no cuenta). */
  #delta(s: ChallengeStep, e: EventEnvelope): number {
    if (s.kind === 'activity') {
      if (e.event_type !== 'player.activity') return 0;
      const a = (e as EventEnvelope<'player.activity'>).payload;
      return a.action === s.action && (!s.feature || a.feature === s.feature) ? 1 : 0;
    }
    if (s.kind === 'loyalty_level') return 0; // se evalúa por estado, no por evento
    if (e.event_type !== s.event_type) return 0;
    if (e.event_type === 'bet.settled') {
      const b = (e as EventEnvelope<'bet.settled'>).payload;
      if (s.product && b.product !== s.product) return 0;
      if (s.kind === 'count') return b.stake.amount_minor > 0 ? 1 : 0; // premios (stake 0) y reversiones no son apuestas
      return b.stake.amount_minor; // suma: la reversión (negativa) descuenta
    }
    const dep = (e as EventEnvelope<'deposit.settled'>).payload;
    return s.kind === 'count' ? 1 : dep.amount_minor;
  }
  #evaluateStatic(c: Challenge, en: Enrollment, p: PlayerProfile) {
    const pk = periodKey(c, this.#now());
    const per = (en.periods[pk] ??= { steps: {}, counted: [], deposits: {} });
    if (per.completed_at) return;
    const prog = this.#d.loyalty.program(p.tenant_id, p.brand_id) ? this.#d.loyalty.progress(p.tenant_id, p.brand_id, p.player_id) : null;
    const rank: Record<string, number> = { Bronce: 0, Plata: 1, Oro: 2, Platino: 3 };
    for (const s of this.#openSteps(c, per)) {
      if (s.kind !== 'loyalty_level') { if (c.mode === 'sequential') break; continue; }
      if (prog && (rank[prog.level] ?? -1) >= (rank[s.level!] ?? 99)) per.steps[s.id] = s.target;
      if (c.mode === 'sequential' && (per.steps[s.id] ?? 0) < s.target) break;
    }
    if (c.steps.every((s) => (per.steps[s.id] ?? 0) >= s.target)) this.#complete(c, en, pk, p);
  }
  /** El planificador o una subida de nivel reevalúan los pasos por estado. */
  refresh(tenant: string, player: string) {
    const p = this.#d.profile(tenant, player);
    if (!p) return;
    for (const en of this.#mine(tenant, player)) {
      const c = this.get(tenant, en.challenge_id, en.version);
      if (en.status === 'active' && c && !this.ineligibility(c, p).length) { this.#evaluateStatic(c, en, p); this.#emit({ enrollments: [en] }); }
    }
  }

  #complete(c: Challenge, en: Enrollment, pk: string, p: PlayerProfile) {
    const per = en.periods[pk];
    per.completed_at = this.#now();
    const key = `challenge:${c.tenant_id}:${c.id}:v${c.version}:${pk}:${p.player_id}`;
    // se revalida la política vigente antes de cualquier incentivo
    const d = this.#d.policy.decide({ profile: p, purpose: 'marketing', incentive: true });
    if (d.kind !== 'allow' && c.reward.reward_id) per.reward = { status: 'suppressed', detail: d.reasons.join(','), idempotency_key: key };
    else {
      if (c.reward.xp) this.#d.loyalty.award(p.tenant_id, p.brand_id, p.player_id, c.reward.xp, `challenge:${c.id}`, key);
      if (c.reward.coins) this.#d.store.adjust({ id: `challenge:${c.id}`, tenant_id: p.tenant_id }, p.player_id, c.reward.coins, `reto completado: ${c.name}`, key);
      if (c.reward.reward_id) {
        const g = this.#d.rewards.grant({ tenant_id: p.tenant_id, player_id: p.player_id, reward_id: c.reward.reward_id, idempotency_key: key, actor: `challenge:${c.id}` });
        per.reward = { status: g.status === 'confirmed' ? 'confirmed' : g.status === 'failed' ? 'failed' : 'pending', detail: g.reason, idempotency_key: key, grant_id: g.grant_id };
      } else per.reward = { status: 'confirmed', detail: 'xp/monedas en el libro del CRM', idempotency_key: key };
    }
    this.#d.audit.record(p.tenant_id, 'system', 'challenge.completed', p.player_id, { challenge: c.id, version: c.version, period: pk, reward: per.reward.status });
    this.#d.realtime.publish(p.tenant_id, p.player_id, 'challenge.completed', { challenge_id: c.id, name: c.name, period: pk, reward: per.reward.status });
    this.#d.realtime.publish(p.tenant_id, p.player_id, 'reward.status', { challenge_id: c.id, status: per.reward.status, detail: per.reward.detail ?? null });
    this.#d.achievements.recordChallengeCompleted(p.tenant_id, p.brand_id, p.player_id);
  }

  /** Reverso de un depósito contado: compensa el paso; si el reto ya se pagó en XP o monedas, asiento compensatorio. */
  #reverse(c: Challenge, en: Enrollment, pk: string, e: EventEnvelope<'deposit.reversed'>, p: PlayerProfile) {
    const per = en.periods[pk];
    const hit = per?.deposits[e.payload.deposit_id];
    if (!hit) return;
    delete per.deposits[e.payload.deposit_id];
    const s = c.steps.find((x) => x.id === hit.step)!;
    per.steps[s.id] = Math.max(0, (per.steps[s.id] ?? 0) - (s.kind === 'count' ? 1 : hit.amount));
    if (per.completed_at && per.reward && per.steps[s.id] < s.target) {
      const key = per.reward.idempotency_key;
      if (c.reward.xp) this.#d.loyalty.reverse(p.tenant_id, p.brand_id, key, `reverso de depósito ${e.payload.deposit_id}`);
      if (c.reward.coins) { const bal = this.#d.store.balance(p.tenant_id, p.player_id); const take = Math.min(bal, c.reward.coins); if (take > 0) this.#d.store.adjust({ id: 'system', tenant_id: p.tenant_id }, p.player_id, -take, `reverso: reto ${c.name}`, `reverse:${key}`); }
      per.reward = { ...per.reward, status: c.reward.reward_id ? per.reward.status : 'reversed', detail: c.reward.reward_id ? 'bono otorgado: revisar (no se revierte automáticamente)' : `compensado por reverso de ${e.payload.deposit_id}` };
      this.#d.audit.record(p.tenant_id, 'system', 'challenge.completion_reversed', p.player_id, { challenge: c.id, deposit_id: e.payload.deposit_id, bonus_under_review: !!c.reward.reward_id });
      this.#d.realtime.publish(p.tenant_id, p.player_id, 'reward.status', { challenge_id: c.id, status: per.reward.status, detail: per.reward.detail });
    }
    this.#emit({ enrollments: [en] });
  }

  // ───────── vistas ─────────
  /** Estado del bono según el servicio de bonos (pendiente → confirmado tras conciliar). */
  #rewardNow(tenant: string, r?: RewardState): RewardState | undefined {
    if (!r || r.status !== 'pending' || !r.idempotency_key) return r;
    const g = this.#d.rewards.grants(tenant).find((x) => x.idempotency_key === r.idempotency_key);
    if (g?.status === 'confirmed') r.status = 'confirmed';
    else if (g?.status === 'failed') r.status = 'failed';
    return r;
  }
  playerView(tenant: string, player: string) {
    const p = this.#d.profile(tenant, player);
    const now = this.#now();
    return this.list(tenant).filter((c) => c.status === 'active' || c.status === 'scheduled' || this.#enroll.has(`${tenant}::${c.id}::${player}`)).map((latest) => {
      const en = this.#enroll.get(`${tenant}::${latest.id}::${player}`);
      const c = (en ? this.get(tenant, latest.id, en.version) : latest) ?? latest;
      const pk = periodKey(c, now);
      const per = en?.periods[pk];
      return {
        id: c.id, version: c.version, name: c.name, description: c.description, period: c.period, mode: c.mode, period_key: pk,
        starts_at: c.starts_at, ends_at: c.ends_at, status: c.status, reward: c.reward,
        steps: c.steps.map((s) => ({ id: s.id, label: s.label, target: s.target, value: Math.min(per?.steps[s.id] ?? 0, s.target), done: (per?.steps[s.id] ?? 0) >= s.target })),
        enrolled: en?.status === 'active', enrollment_status: en?.status ?? null, suspended_reason: en?.suspended_reason ?? null, notify: en?.notify ?? false,
        completed_at: per?.completed_at ?? null, reward_state: this.#rewardNow(tenant, per?.reward) ?? null,
        ineligible: this.ineligibility(c, p, now),
      };
    });
  }
  enrollments(tenant: string, id?: string) { return [...this.#enroll.values()].filter((e) => e.tenant_id === tenant && (!id || e.challenge_id === id)); }
  /** Métricas por reto. Definiciones en docs/GAMIFICACION.md. */
  stats(tenant: string, eligiblePlayers: (c: Challenge) => number) {
    return this.list(tenant).map((c) => {
      const ens = this.enrollments(tenant, c.id);
      const pers = ens.flatMap((e) => Object.values(e.periods));
      const started = pers.filter((x) => Object.values(x.steps).some((v) => v > 0)).length;
      const completed = pers.filter((x) => x.completed_at).length;
      const rewards = pers.map((x) => this.#rewardNow(tenant, x.reward)).filter(Boolean) as RewardState[];
      return { id: c.id, name: c.name, version: c.version, status: c.status, period: c.period, brand_id: c.brand_id, market: c.market ?? null, starts_at: c.starts_at, ends_at: c.ends_at,
        eligible: eligiblePlayers(c), enrolled: ens.filter((e) => e.status === 'active').length, suspended: ens.filter((e) => e.status === 'suspended').length,
        participants: pers.length, start_rate: pers.length ? started / pers.length : null, completion_rate: pers.length ? completed / pers.length : null,
        rewards_confirmed: rewards.filter((r) => r.status === 'confirmed').length, rewards_pending: rewards.filter((r) => r.status === 'pending').length,
        rewards_suppressed: rewards.filter((r) => r.status === 'suppressed').length, rewards_reversed: rewards.filter((r) => r.status === 'reversed').length };
    });
  }
  /** Simulación sin efectos: qué pasos cumpliría una lista de eventos (no inscribe, no otorga, no avisa). */
  simulate(tenant: string, id: string, p: PlayerProfile, events: EventEnvelope[]) {
    const c = this.get(tenant, id);
    if (!c) throw new DomainError('not_found', `No existe el reto ${id}.`);
    const steps: Record<string, number> = {};
    const trace: { event: string; step?: string; value?: number; note?: string }[] = [];
    const per = { steps, counted: [] as string[], deposits: {} };
    for (const e of events) {
      const open = this.#openSteps(c, per);
      let hit = false;
      for (const s of open) { const d = this.#delta(s, e); if (!d) continue; steps[s.id] = Math.max(0, (steps[s.id] ?? 0) + d); trace.push({ event: e.event_type, step: s.id, value: steps[s.id] }); hit = true; if (c.mode === 'sequential') break; }
      if (!hit) trace.push({ event: e.event_type, note: c.mode === 'sequential' && open[0] ? `no cuenta: el paso en curso es «${open[0].label}»` : 'no cuenta para ningún paso' });
    }
    return { challenge: c.id, version: c.version, ineligible: this.ineligibility({ ...c, status: 'active' }, p), steps: c.steps.map((s) => ({ id: s.id, label: s.label, target: s.target, value: steps[s.id] ?? 0, done: (steps[s.id] ?? 0) >= s.target })), completes: c.steps.every((s) => (steps[s.id] ?? 0) >= s.target), trace, effects: 'ninguno: simulación' };
  }

  restore(x: { challenges?: Challenge[]; enrollments?: Enrollment[] }) {
    for (const c of x.challenges ?? []) {
      const k = `${c.tenant_id}::${c.id}`; const vs = this.#defs.get(k) ?? [];
      const i = vs.findIndex((v) => v.version === c.version); if (i >= 0) vs[i] = c; else vs.push(c);
      vs.sort((a, b) => a.version - b.version); this.#defs.set(k, vs);
    }
    for (const e of x.enrollments ?? []) this.#enroll.set(`${e.tenant_id}::${e.challenge_id}::${e.player_id}`, e);
  }
}

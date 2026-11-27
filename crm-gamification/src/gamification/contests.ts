/**
 * Concursos: bases publicadas, requisitos sin compra, participaciones, revisión con descalificación
 * motivada, selección de ganadores (sorteo o jurado) y aprobación de ganadores por otra persona antes
 * de entregar premios.
 *
 * Ciclo: borrador → enviado → aprobado (firma de las bases y compromiso de la semilla del sorteo) → abierto
 * → cerrado (fin de la inscripción) → ganadores propuestos → ganadores aprobados y premios entregados.
 * Se puede cancelar con motivo en cualquier momento antes de pagar.
 *
 * Sorteo: se delega en un mecanismo de sorteo (`DrawProvider`). El de demostración usa compromiso y
 * revelación (sha256 de la semilla publicado al aprobar; la semilla se revela al sortear), es reproducible
 * y verificable, pero **no** es un mecanismo autorizado: en producción no se aprueban ganadores de un
 * sorteo hecho con él. SS1 debe proveer el mecanismo autorizado (certificado o ante notario) del mercado.
 *
 * Juego responsable: la participación no exige depósito ni apuesta (los requisitos son de perfil o nivel);
 * no participa quien tiene restricción, caso abierto o señal reciente, y se revalida al entregar el premio.
 */
import type { AuditLog } from '../audit/audit.ts';
import { canonical } from '../journeys/registry.ts';
import type { LoyaltyService } from '../loyalty/loyalty.ts';
import type { PolicyEngine } from '../policy/policyEngine.ts';
import type { PlayerProfile } from '../profile/projection.ts';
import type { RewardService } from '../rewards/rewards.ts';
import { DomainError, sha256, uuid, type Clock } from '../shared/util.ts';
import type { AchievementService } from './achievements.ts';
import type { RealtimeHub } from './realtime.ts';
import { LOSS_CHASING, rgIneligibility } from './safeguards.ts';
import type { StoreService } from './store.ts';

export type ContestPrize = { place: number; label: string; xp?: number; coins?: number; reward_id?: string };
export type ContestStatus = 'draft' | 'pending_approval' | 'open' | 'closed' | 'winners_pending' | 'finished' | 'cancelled';
export type Contest = {
  id: string; tenant_id: string; brand_id: string; name: string; rules: string; question?: string;
  kind: 'draw' | 'judged';
  requirements: { profile_completed?: boolean; min_level?: string };
  opens_at: string; closes_at: string; prizes: ContestPrize[];
  status: ContestStatus; created_by: string; approved_by?: string; rules_signature?: string;
  draw?: { provider: string; authorized: boolean; seed_commit: string; seed?: string; drawn_at?: string; drawn_by?: string; proof?: string };
  winners?: { player_id: string; place: number; motivation?: string }[]; selected_by?: string;
  winners_approved_by?: string; payouts?: { player_id: string; place: number; status: string }[];
  cancel_reason?: string; created_at: string; updated_at: string;
};
export type ContestEntry = {
  contest_id: string; tenant_id: string; player_id: string; at: string; answer?: string;
  status: 'valid' | 'disqualified'; disqualification?: { code: string; reason: string; by: string; at: string };
};

/** Mecanismo de sorteo: recibe las participaciones válidas (ordenadas) y devuelve los ganadores con su prueba. */
export interface DrawProvider {
  readonly name: string;
  readonly authorized: boolean;
  /** Al aprobar el concurso: compromiso público (p. ej. sha256 de la semilla). */
  commit(contestId: string): { commit: string; secret: string };
  draw(input: { contest_id: string; entries: string[]; winners: number; secret: string }): { winners: string[]; proof: string };
}

/** Demostración: compromiso y revelación. Verificable y reproducible, pero no autorizado para sorteos reales. */
export const demoDrawProvider: DrawProvider = {
  name: 'demo-commit-reveal', authorized: false,
  commit() { const secret = sha256(uuid() + uuid()); return { commit: sha256(secret), secret }; },
  draw({ contest_id, entries, winners, secret }) {
    const order = [...entries].sort().map((p) => ({ p, k: sha256(`${secret}:${contest_id}:${p}`) })).sort((a, b) => a.k.localeCompare(b.k));
    return { winners: order.slice(0, winners).map((x) => x.p), proof: sha256(JSON.stringify(order.map((x) => [x.p, x.k]))) };
  },
};

export const DISQUALIFY_CODES = ['duplicate_account', 'rules_breach', 'ineligible', 'fraud_suspected', 'offensive_content'] as const;

export type ContestDeps = {
  clock: Clock; audit: AuditLog; loyalty: LoyaltyService; rewards: RewardService; store: StoreService; policy: PolicyEngine; realtime: RealtimeHub; achievements: AchievementService;
  profile: (t: string, p: string) => PlayerProfile | undefined; riskHold?: (t: string, p: string) => boolean;
  draw?: DrawProvider; allowUnauthorizedDraw?: boolean;
};
type Actor = { id: string; tenant_id: string };
const signed = (c: Contest) => ({ id: c.id, brand_id: c.brand_id, rules: c.rules, question: c.question ?? null, kind: c.kind, requirements: c.requirements, opens_at: c.opens_at, closes_at: c.closes_at, prizes: c.prizes });

export class ContestService {
  #d: ContestDeps;
  #draw: DrawProvider;
  #contests = new Map<string, Contest>();
  #entries = new Map<string, ContestEntry>(); // tenant::contest::player
  #secrets = new Map<string, string>(); // tenant::contest → semilla (se revela al sortear)
  onChange?: (x: { contests?: Contest[]; entries?: ContestEntry[]; secrets?: { tenant_id: string; contest_id: string; secret: string }[] }) => void;
  constructor(d: ContestDeps) { this.#d = d; this.#draw = d.draw ?? demoDrawProvider; }
  #now() { return this.#d.clock.now().toISOString(); }
  get provider() { return { name: this.#draw.name, authorized: this.#draw.authorized }; }

  static validate(c: Partial<Contest>): string[] {
    const e: string[] = [];
    if (!/^[\w-]{3,48}$/.test(String(c.id ?? ''))) e.push('id: 3 a 48 letras, números, guion o guion bajo');
    if (!c.name || c.name.length < 3 || c.name.length > 80) e.push('nombre: 3 a 80 caracteres');
    if (!c.rules || c.rules.length < 40) e.push('bases: al menos 40 caracteres (requisitos, fechas, premios, cómo se eligen los ganadores)');
    if (LOSS_CHASING.test(`${c.name ?? ''} ${c.rules ?? ''} ${c.question ?? ''}`)) e.push('juego responsable: un concurso no puede invitar a recuperar pérdidas');
    if (/\b(deposit|apuest|bet\b|wager)/i.test(JSON.stringify(c.requirements ?? {}))) e.push('requisitos: participar no puede exigir depósitos ni apuestas');
    if (c.kind !== 'draw' && c.kind !== 'judged') e.push('tipo: sorteo o jurado');
    if (c.kind === 'judged' && (!c.question || c.question.length < 5)) e.push('jurado: indica la pregunta o consigna');
    if (!Array.isArray(c.prizes) || !c.prizes.length || c.prizes.length > 50) e.push('premios: entre 1 y 50');
    else {
      const places = c.prizes.map((p) => p.place);
      if (new Set(places).size !== places.length || places.some((p, i) => p !== i + 1)) e.push('premios: puestos 1, 2, 3… sin saltos');
      if (c.prizes.some((p) => !p.label || (!p.xp && !p.coins && !p.reward_id))) e.push('premios: cada puesto con nombre y recompensa');
    }
    if (!c.opens_at || !c.closes_at || Number.isNaN(Date.parse(c.opens_at)) || Date.parse(c.closes_at) <= Date.parse(c.opens_at)) e.push('fechas: el cierre va después de la apertura');
    return e;
  }

  saveDraft(actor: Actor, input: Omit<Contest, 'tenant_id' | 'status' | 'created_by' | 'created_at' | 'updated_at'>): Contest {
    const errs = ContestService.validate(input);
    for (const p of input.prizes ?? []) if (p.reward_id && !this.#d.rewards.item(actor.tenant_id, p.reward_id)) errs.push(`bono ${p.reward_id} no existe en el catálogo`);
    if (errs.length) throw new DomainError('invalid_contest', errs.join('; '));
    const prev = this.#contests.get(`${actor.tenant_id}::${input.id}`);
    if (prev && prev.status !== 'draft' && prev.status !== 'pending_approval') throw new DomainError('immutable', 'Las bases de un concurso aprobado no cambian: crea otro.');
    const now = this.#now();
    const c: Contest = { ...structuredClone(input), requirements: input.requirements ?? {}, tenant_id: actor.tenant_id, status: 'draft', created_by: actor.id, created_at: prev?.created_at ?? now, updated_at: now };
    this.#contests.set(`${actor.tenant_id}::${c.id}`, c);
    this.#d.audit.record(actor.tenant_id, actor.id, 'contest.draft_saved', c.id, { kind: c.kind, prizes: c.prizes.length });
    this.onChange?.({ contests: [c] });
    return c;
  }
  submit(actor: Actor, id: string) {
    const c = this.#must(actor.tenant_id, id);
    if (c.status !== 'draft') throw new DomainError('invalid_state', `El concurso está en «${c.status}».`);
    c.status = 'pending_approval'; c.updated_at = this.#now();
    this.#d.audit.record(actor.tenant_id, actor.id, 'contest.submitted', id, {});
    this.onChange?.({ contests: [c] });
    return c;
  }
  /** Aprobación (otra persona): firma de las bases y, si es sorteo, compromiso público de la semilla. */
  approve(actor: Actor, id: string) {
    const c = this.#must(actor.tenant_id, id);
    if (c.status !== 'pending_approval') throw new DomainError('invalid_state', 'Solo se aprueba un concurso enviado.');
    if (c.created_by === actor.id) throw new DomainError('segregation_of_duties', 'Quien crea el concurso no puede aprobarlo.');
    c.approved_by = actor.id; c.rules_signature = sha256(canonical({ ...signed(c), approver: actor.id }));
    const secrets: { tenant_id: string; contest_id: string; secret: string }[] = [];
    if (c.kind === 'draw') {
      const cm = this.#draw.commit(c.id);
      c.draw = { provider: this.#draw.name, authorized: this.#draw.authorized, seed_commit: cm.commit };
      this.#secrets.set(`${c.tenant_id}::${c.id}`, cm.secret);
      secrets.push({ tenant_id: c.tenant_id, contest_id: c.id, secret: cm.secret });
    }
    c.status = 'open'; c.updated_at = this.#now();
    this.#d.audit.record(actor.tenant_id, actor.id, 'contest.approved', id, { signature: c.rules_signature, seed_commit: c.draw?.seed_commit ?? null, provider: c.draw?.provider ?? null });
    this.onChange?.({ contests: [c], secrets });
    return c;
  }
  cancel(actor: Actor, id: string, reason: string) {
    const c = this.#must(actor.tenant_id, id);
    if (!reason || reason.trim().length < 10) throw new DomainError('reason_required', 'Indica el motivo de la cancelación (al menos 10 caracteres).');
    if (c.status === 'finished') throw new DomainError('invalid_state', 'Los premios ya se entregaron.');
    c.status = 'cancelled'; c.cancel_reason = reason; c.updated_at = this.#now();
    this.#d.audit.record(actor.tenant_id, actor.id, 'contest.cancelled', id, { reason });
    for (const e of this.entries(actor.tenant_id, id)) this.#d.realtime.publish(e.tenant_id, e.player_id, 'contest.result', { contest_id: id, name: c.name, status: 'cancelled' });
    this.onChange?.({ contests: [c] });
    return c;
  }
  /** Cierre de la inscripción (manual o por fecha). */
  close(actor: Actor, id: string) {
    const c = this.#must(actor.tenant_id, id);
    if (c.status === 'closed') return c;
    if (c.status !== 'open') throw new DomainError('invalid_state', `El concurso está en «${c.status}».`);
    c.status = 'closed'; c.updated_at = this.#now();
    this.#d.audit.record(actor.tenant_id, actor.id, 'contest.closed', id, { entries: this.entries(actor.tenant_id, id).length });
    this.onChange?.({ contests: [c] });
    return c;
  }
  tick(): number {
    let n = 0; const now = this.#d.clock.now().getTime();
    for (const c of this.#contests.values()) if (c.status === 'open' && Date.parse(c.closes_at) < now) { this.close({ id: 'system', tenant_id: c.tenant_id }, c.id); n++; }
    return n;
  }

  // ───────── jugador ─────────
  ineligibility(c: Contest, p: PlayerProfile | undefined, at = this.#now()): string[] {
    if (!p) return ['player_not_found'];
    const r: string[] = [];
    if (c.status !== 'open') r.push('not_open');
    if (p.brand_id !== c.brand_id) r.push('other_brand');
    if (at < c.opens_at || at > c.closes_at) r.push('outside_window');
    r.push(...rgIneligibility({ loyalty: this.#d.loyalty, riskHold: this.#d.riskHold }, p, at));
    if (c.requirements.profile_completed && !this.#d.achievements.mine(p.tenant_id, p.brand_id, p.player_id).some((a) => a.id === 'perfil_completo' && a.level)) r.push('profile_incomplete');
    if (c.requirements.min_level) {
      const prog = this.#d.loyalty.program(p.tenant_id, p.brand_id);
      const rank = (lv: string) => prog?.levels.findIndex((l) => l.name === lv) ?? -1;
      if (!prog || rank(this.#d.loyalty.progress(p.tenant_id, p.brand_id, p.player_id).level) < rank(c.requirements.min_level)) r.push('level_too_low');
    }
    return r;
  }
  enter(tenant: string, player: string, id: string, o: { answer?: string; accept_rules: boolean }): ContestEntry {
    const c = this.#must(tenant, id);
    const prev = this.#entries.get(`${tenant}::${id}::${player}`);
    if (prev) return prev; // una participación por jugador; repetir no duplica
    if (o.accept_rules !== true) throw new DomainError('rules_not_accepted', 'Para participar hay que aceptar las bases.');
    const why = this.ineligibility(c, this.#d.profile(tenant, player));
    if (why.length) throw new DomainError('not_eligible', `No puedes participar: ${why.join(', ')}.`);
    if (c.kind === 'judged' && (!o.answer || o.answer.trim().length < 3 || o.answer.length > 500)) throw new DomainError('invalid_answer', 'Escribe tu respuesta (3 a 500 caracteres).');
    const e: ContestEntry = { contest_id: id, tenant_id: tenant, player_id: player, at: this.#now(), ...(c.kind === 'judged' ? { answer: o.answer!.trim() } : {}), status: 'valid' };
    this.#entries.set(`${tenant}::${id}::${player}`, e);
    this.#d.audit.record(tenant, `player:${player}`, 'contest.entered', id, { rules_signature: c.rules_signature });
    this.onChange?.({ entries: [e] });
    return e;
  }

  // ───────── revisión ─────────
  disqualify(actor: Actor, id: string, player: string, code: string, reason: string) {
    const c = this.#must(actor.tenant_id, id);
    if (!['open', 'closed'].includes(c.status)) throw new DomainError('invalid_state', 'Solo se revisan participaciones antes de proponer ganadores.');
    const e = this.#entries.get(`${actor.tenant_id}::${id}::${player}`);
    if (!e) throw new DomainError('not_found', 'Participación inexistente.');
    if (!(DISQUALIFY_CODES as readonly string[]).includes(code)) throw new DomainError('invalid_code', `Motivo: ${DISQUALIFY_CODES.join(', ')}.`);
    if (!reason || reason.trim().length < 10) throw new DomainError('reason_required', 'Explica la descalificación (al menos 10 caracteres); queda en la auditoría.');
    e.status = 'disqualified'; e.disqualification = { code, reason, by: actor.id, at: this.#now() };
    this.#d.audit.record(actor.tenant_id, actor.id, 'contest.entry_disqualified', id, { player, code, reason });
    this.onChange?.({ entries: [e] });
    return e;
  }
  reinstate(actor: Actor, id: string, player: string, reason: string) {
    const c = this.#must(actor.tenant_id, id);
    if (!['open', 'closed'].includes(c.status)) throw new DomainError('invalid_state', 'Solo antes de proponer ganadores.');
    const e = this.#entries.get(`${actor.tenant_id}::${id}::${player}`);
    if (!e || e.status !== 'disqualified') throw new DomainError('not_found', 'No hay una descalificación que revertir.');
    if (!reason || reason.trim().length < 10) throw new DomainError('reason_required', 'Explica por qué se revierte (al menos 10 caracteres).');
    e.status = 'valid'; this.#d.audit.record(actor.tenant_id, actor.id, 'contest.entry_reinstated', id, { player, reason, previous: e.disqualification });
    e.disqualification = undefined;
    this.onChange?.({ entries: [e] });
    return e;
  }

  // ───────── ganadores ─────────
  #validEntries(t: string, id: string) {
    const now = this.#now();
    // al elegir ganadores se excluye a quien hoy tiene restricción (se vuelve a revisar al pagar)
    return this.entries(t, id).filter((e) => e.status === 'valid').filter((e) => { const p = this.#d.profile(t, e.player_id); return p && !rgIneligibility({ loyalty: this.#d.loyalty, riskHold: this.#d.riskHold }, p, now).length; }).map((e) => e.player_id).sort();
  }
  /** Sorteo con el mecanismo configurado; revela la semilla para verificación. */
  drawWinners(actor: Actor, id: string) {
    const c = this.#must(actor.tenant_id, id);
    if (c.kind !== 'draw') throw new DomainError('invalid_kind', 'Este concurso lo decide un jurado.');
    if (c.status !== 'closed') throw new DomainError('invalid_state', 'Primero cierra la inscripción.');
    const secret = this.#secrets.get(`${c.tenant_id}::${id}`);
    if (!secret || !c.draw) throw new DomainError('no_commit', 'Falta el compromiso del sorteo.');
    const entries = this.#validEntries(c.tenant_id, id);
    if (!entries.length) throw new DomainError('no_entries', 'No hay participaciones válidas.');
    const out = this.#draw.draw({ contest_id: id, entries, winners: Math.min(c.prizes.length, entries.length), secret });
    c.winners = out.winners.map((p, i) => ({ player_id: p, place: i + 1 }));
    c.draw = { ...c.draw, seed: secret, drawn_at: this.#now(), drawn_by: actor.id, proof: out.proof };
    c.selected_by = actor.id; c.status = 'winners_pending'; c.updated_at = this.#now();
    this.#d.audit.record(actor.tenant_id, actor.id, 'contest.drawn', id, { provider: c.draw.provider, authorized: c.draw.authorized, entries: entries.length, winners: c.winners.length, proof: out.proof });
    this.onChange?.({ contests: [c] });
    return c;
  }
  /** Verificación independiente del sorteo de demostración: misma semilla y participaciones ⇒ mismos ganadores. */
  verifyDraw(t: string, id: string) {
    const c = this.#must(t, id);
    if (!c.draw?.seed) throw new DomainError('not_drawn', 'El sorteo no se ha realizado.');
    const entries = this.#validEntries(t, id);
    const commitOk = sha256(c.draw.seed) === c.draw.seed_commit;
    const re = c.draw.provider === demoDrawProvider.name ? demoDrawProvider.draw({ contest_id: id, entries, winners: c.winners?.length ?? 0, secret: c.draw.seed }) : null;
    return { provider: c.draw.provider, authorized: c.draw.authorized, seed_commit: c.draw.seed_commit, seed: c.draw.seed, commit_matches: commitOk, entries: entries.length, winners: c.winners?.map((w) => w.player_id) ?? [], reproduced: re ? JSON.stringify(re.winners) === JSON.stringify(c.winners?.map((w) => w.player_id)) && re.proof === c.draw.proof : null };
  }
  /** Jurado: propone ganadores con una motivación por puesto. */
  selectWinners(actor: Actor, id: string, picks: { player_id: string; motivation: string }[]) {
    const c = this.#must(actor.tenant_id, id);
    if (c.kind !== 'judged') throw new DomainError('invalid_kind', 'Los ganadores de un sorteo los define el mecanismo de sorteo.');
    if (c.status !== 'closed') throw new DomainError('invalid_state', 'Primero cierra la inscripción.');
    const valid = new Set(this.#validEntries(c.tenant_id, id));
    if (!Array.isArray(picks) || !picks.length || picks.length > c.prizes.length) throw new DomainError('invalid_winners', `Elige entre 1 y ${c.prizes.length} ganadores.`);
    if (new Set(picks.map((p) => p.player_id)).size !== picks.length) throw new DomainError('invalid_winners', 'Un jugador no puede ganar dos puestos.');
    for (const p of picks) {
      if (!valid.has(p.player_id)) throw new DomainError('invalid_winners', `${p.player_id} no tiene una participación válida.`);
      if (!p.motivation || p.motivation.trim().length < 10) throw new DomainError('reason_required', 'Motiva cada elección (al menos 10 caracteres).');
    }
    c.winners = picks.map((p, i) => ({ player_id: p.player_id, place: i + 1, motivation: p.motivation }));
    c.selected_by = actor.id; c.status = 'winners_pending'; c.updated_at = this.#now();
    this.#d.audit.record(actor.tenant_id, actor.id, 'contest.winners_selected', id, { winners: c.winners });
    this.onChange?.({ contests: [c] });
    return c;
  }
  /** Aprobación de ganadores (otra persona): revalida juego responsable y política, y entrega una sola vez. */
  approveWinners(actor: Actor, id: string) {
    const c = this.#must(actor.tenant_id, id);
    if (c.status === 'finished') return c;
    if (c.status !== 'winners_pending' || !c.winners) throw new DomainError('invalid_state', 'No hay ganadores propuestos.');
    if (actor.id === c.selected_by || actor.id === c.created_by) throw new DomainError('segregation_of_duties', 'Quien crea el concurso o elige a los ganadores no los aprueba.');
    if (c.kind === 'draw' && c.draw && !c.draw.authorized && !this.#d.allowUnauthorizedDraw) throw new DomainError('draw_not_authorized', `El sorteo se hizo con «${c.draw.provider}», que no es un mecanismo autorizado. Configura el mecanismo de sorteo autorizado de SS1.`);
    const payouts: NonNullable<Contest['payouts']> = [];
    for (const w of c.winners) {
      const prize = c.prizes.find((p) => p.place === w.place)!;
      const p = this.#d.profile(c.tenant_id, w.player_id);
      const key = `contest:${c.tenant_id}:${id}:${w.player_id}`;
      if (!p || rgIneligibility({ loyalty: this.#d.loyalty, riskHold: this.#d.riskHold }, p, this.#now()).length) { payouts.push({ player_id: w.player_id, place: w.place, status: 'suppressed:rg_at_approval' }); continue; }
      let status = 'confirmed';
      if (prize.xp) this.#d.loyalty.award(c.tenant_id, p.brand_id, w.player_id, prize.xp, `contest:${id}`, key);
      if (prize.coins) this.#d.store.adjust({ id: `contest:${id}`, tenant_id: c.tenant_id }, w.player_id, prize.coins, `concurso: ${c.name}`, key);
      if (prize.reward_id) {
        const dec = this.#d.policy.decide({ profile: p, purpose: 'marketing', incentive: true });
        status = dec.kind === 'allow' ? this.#d.rewards.grant({ tenant_id: c.tenant_id, player_id: w.player_id, reward_id: prize.reward_id, idempotency_key: key, actor: `contest:${id}` }).status : `suppressed:${dec.reasons.join(',')}`;
      }
      payouts.push({ player_id: w.player_id, place: w.place, status });
      this.#d.realtime.publish(c.tenant_id, w.player_id, 'contest.result', { contest_id: id, name: c.name, place: w.place, prize: prize.label, status });
    }
    c.payouts = payouts; c.winners_approved_by = actor.id; c.status = 'finished'; c.updated_at = this.#now();
    this.#d.audit.record(actor.tenant_id, actor.id, 'contest.winners_approved', id, { payouts });
    this.onChange?.({ contests: [c] });
    return c;
  }

  // ───────── vistas ─────────
  #must(t: string, id: string) { const c = this.#contests.get(`${t}::${id}`); if (!c) throw new DomainError('not_found', `No existe el concurso ${id}.`); return c; }
  get(t: string, id: string) { return this.#contests.get(`${t}::${id}`); }
  list(t: string) { return [...this.#contests.values()].filter((c) => c.tenant_id === t); }
  entries(t: string, id: string) { return [...this.#entries.values()].filter((e) => e.tenant_id === t && e.contest_id === id); }
  stats(t: string) {
    return this.list(t).map((c) => {
      const es = this.entries(t, c.id);
      return { id: c.id, name: c.name, kind: c.kind, status: c.status, opens_at: c.opens_at, closes_at: c.closes_at, prizes: c.prizes.length,
        entries: es.length, valid: es.filter((e) => e.status === 'valid').length, disqualified: es.filter((e) => e.status === 'disqualified').length,
        winners: c.winners?.length ?? 0, paid: c.payouts?.filter((p) => !p.status.startsWith('suppressed')).length ?? 0,
        provider: c.draw?.provider ?? null, provider_authorized: c.draw?.authorized ?? null, created_by: c.created_by, approved_by: c.approved_by ?? null, selected_by: c.selected_by ?? null };
    });
  }
  /** Lo que ve el jugador: concursos abiertos para él, sus participaciones y los resultados (con nombre público). */
  playerView(t: string, player: string, display: (p: string) => string) {
    const p = this.#d.profile(t, player);
    return this.list(t).filter((c) => ['open', 'closed', 'winners_pending', 'finished', 'cancelled'].includes(c.status) && (c.status === 'open' || this.#entries.has(`${t}::${c.id}::${player}`))).map((c) => {
      const e = this.#entries.get(`${t}::${c.id}::${player}`);
      const mine = c.status === 'finished' ? c.winners?.find((w) => w.player_id === player) : undefined;
      return { id: c.id, name: c.name, rules: c.rules, question: c.question ?? null, kind: c.kind, closes_at: c.closes_at, status: c.status, prizes: c.prizes.map((x) => ({ place: x.place, label: x.label })),
        entered: !!e, entry_status: e?.status ?? null, ineligible: e ? [] : this.ineligibility(c, p),
        result: c.status === 'finished' ? { won: !!mine, place: mine?.place ?? null, winners: (c.winners ?? []).map((w) => ({ place: w.place, display: display(w.player_id) })) } : null };
    });
  }
  restore(x: { contests?: Contest[]; entries?: ContestEntry[]; secrets?: { tenant_id: string; contest_id: string; secret: string }[] }) {
    for (const c of x.contests ?? []) this.#contests.set(`${c.tenant_id}::${c.id}`, c);
    for (const e of x.entries ?? []) this.#entries.set(`${e.tenant_id}::${e.contest_id}::${e.player_id}`, e);
    for (const s of x.secrets ?? []) this.#secrets.set(`${s.tenant_id}::${s.contest_id}`, s.secret);
  }
}

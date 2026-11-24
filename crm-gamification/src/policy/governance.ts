import type { AuditLog } from '../audit/audit.ts';
import { CHANNELS, type Channel } from '../domain/events.ts';
import { DomainError, HOUR, type Clock } from '../shared/util.ts';
import type { MarketPolicy, PolicyEngine } from './policyEngine.ts';

/**
 * I3 · Topes jurisdiccionales editables por mercado, con aprobación.
 * Cumplimiento o JR proponen una versión nueva; otra persona con rol aprobador la
 * aprueba y recién entonces el motor de políticas la aplica. Todo cambio que relaje
 * una protección exige justificación escrita y queda marcado para quien aprueba.
 * Si otra versión se aprobó mientras tanto, la propuesta queda obsoleta (sin pisar cambios).
 */
export type PolicyChange = { field: string; from: unknown; to: unknown; loosens: boolean };
export type PolicyProposal = {
  id: string; tenant_id: string; brand_id: string; market: string; base_version: string | null; proposed: MarketPolicy; changes: PolicyChange[];
  justification: string; status: 'pending' | 'approved' | 'rejected' | 'superseded'; proposed_by: string; proposed_at: string; decided_by?: string; decided_at?: string; reject_reason?: string;
};

const quietLen = (q: { start: number; end: number }) => (q.end - q.start + 24) % 24;

export function validatePolicy(p: Partial<MarketPolicy>): string[] {
  const e: string[] = [];
  const int = (x: unknown, lo: number, hi: number) => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;
  if (!/^[A-Z]{2}$/.test(p.market ?? '')) e.push('El mercado es un código de país de 2 letras (p. ej. CO, PE, MX).');
  if (!/^[a-z0-9_-]{2,30}$/.test(p.brand_id ?? '')) e.push('Marca no válida.');
  if (!Array.isArray(p.channels_enabled) || !p.channels_enabled.length || p.channels_enabled.some((c) => !CHANNELS.includes(c))) e.push(`Canales habilitados: al menos uno de ${CHANNELS.join(', ')}.`);
  if (!int(p.max_marketing_per_day, 0, 10)) e.push('Máximo diario de marketing: entero entre 0 y 10.');
  for (const [c, n] of Object.entries(p.max_marketing_per_day_by_channel ?? {})) {
    if (!CHANNELS.includes(c as Channel)) e.push(`Canal desconocido en topes por canal: ${c}.`);
    else if (!int(n, 0, 10) || (n as number) > (p.max_marketing_per_day ?? 0)) e.push(`Tope diario de ${c}: entero entre 0 y el máximo diario global.`);
  }
  if (p.max_marketing_per_week !== undefined && (!int(p.max_marketing_per_week, 0, 50) || p.max_marketing_per_week < (p.max_marketing_per_day ?? 0))) e.push('Tope semanal: entero entre el máximo diario y 50.');
  if (!p.quiet_hours || !int(p.quiet_hours.start, 0, 23) || !int(p.quiet_hours.end, 0, 23)) e.push('Horario silencioso: horas enteras de 0 a 23.');
  else if (quietLen(p.quiet_hours) > 14) e.push('El horario silencioso no puede superar 14 horas.');
  if (!(Number(p.rg_feed_max_staleness_ms) >= 0.25 * HOUR && Number(p.rg_feed_max_staleness_ms) <= 24 * HOUR)) e.push('Antigüedad máxima del feed de juego responsable: entre 15 minutos y 24 horas.');
  if (typeof p.incentives_allowed !== 'boolean' || typeof p.require_kyc_for_incentives !== 'boolean') e.push('Incentivos y KYC deben ser sí o no.');
  return e;
}

/** Diferencias campo a campo; `loosens` marca lo que reduce una protección. */
export function diffPolicy(a: MarketPolicy | undefined, b: MarketPolicy): PolicyChange[] {
  const out: PolicyChange[] = [];
  const push = (field: string, from: unknown, to: unknown, loosens: boolean) => { if (JSON.stringify(from) !== JSON.stringify(to)) out.push({ field, from, to, loosens }); };
  const prev = a;
  push('channels_enabled', prev?.channels_enabled ?? null, b.channels_enabled, !!prev && b.channels_enabled.some((c) => !prev.channels_enabled.includes(c)));
  push('max_marketing_per_day', prev?.max_marketing_per_day ?? null, b.max_marketing_per_day, !!prev && b.max_marketing_per_day > prev.max_marketing_per_day);
  for (const c of CHANNELS) {
    const f = prev?.max_marketing_per_day_by_channel?.[c], t = b.max_marketing_per_day_by_channel?.[c];
    push(`max_marketing_per_day_by_channel.${c}`, f ?? null, t ?? null, !!prev && (t === undefined ? f !== undefined : f !== undefined && t > f));
  }
  push('max_marketing_per_week', prev?.max_marketing_per_week ?? null, b.max_marketing_per_week ?? null, !!prev && (b.max_marketing_per_week === undefined ? prev.max_marketing_per_week !== undefined : prev.max_marketing_per_week !== undefined && b.max_marketing_per_week > prev.max_marketing_per_week));
  push('quiet_hours', prev?.quiet_hours ?? null, b.quiet_hours, !!prev && quietLen(b.quiet_hours) < quietLen(prev.quiet_hours));
  push('incentives_allowed', prev?.incentives_allowed ?? null, b.incentives_allowed, !!prev && !prev.incentives_allowed && b.incentives_allowed);
  push('require_kyc_for_incentives', prev?.require_kyc_for_incentives ?? null, b.require_kyc_for_incentives, !!prev && prev.require_kyc_for_incentives && !b.require_kyc_for_incentives);
  push('rg_feed_max_staleness_ms', prev?.rg_feed_max_staleness_ms ?? null, b.rg_feed_max_staleness_ms, !!prev && b.rg_feed_max_staleness_ms > prev.rg_feed_max_staleness_ms);
  return out;
}

export class PolicyGovernance {
  #proposals = new Map<string, PolicyProposal>();
  #history = new Map<string, { version: string; approved_by: string; at: string; proposal_id: string }[]>();
  #policy: PolicyEngine; #audit: AuditLog; #clock: Clock;
  constructor(deps: { policy: PolicyEngine; audit: AuditLog; clock: Clock }) { this.#policy = deps.policy; this.#audit = deps.audit; this.#clock = deps.clock; }

  proposals(tenant: string) { return [...this.#proposals.values()].filter((p) => p.tenant_id === tenant).sort((a, b) => b.proposed_at.localeCompare(a.proposed_at)); }
  history(tenant: string, brand: string, market: string) { return this.#history.get(`${tenant}::${brand}::${market}`) ?? []; }

  propose(actor: { id: string; tenant_id: string }, input: Omit<MarketPolicy, 'version'>, justification: string): PolicyProposal {
    const errs = validatePolicy(input);
    if (errs.length) throw new DomainError('invalid_policy', errs.join(' '));
    const current = this.#policy.listPolicies(actor.tenant_id).find((p) => p.brand_id === input.brand_id && p.market === input.market);
    const n = this.history(actor.tenant_id, input.brand_id, input.market).length + this.proposals(actor.tenant_id).filter((p) => p.market === input.market && p.brand_id === input.brand_id).length + 1;
    const version = `${input.market.toLowerCase()}-${input.brand_id}-${this.#clock.now().toISOString().slice(0, 10).replace(/-/g, '.')}.${n}`;
    const proposed: MarketPolicy = { ...structuredClone(input), version };
    const changes = diffPolicy(current, proposed);
    if (current && !changes.length) throw new DomainError('no_changes', 'La propuesta es igual a la política vigente.');
    if (changes.some((c) => c.loosens) && justification.trim().length < 20) throw new DomainError('justification_required', 'Este cambio relaja una protección: explica el motivo regulatorio o de negocio (mínimo 20 caracteres).');
    const p: PolicyProposal = { id: `pp_${version}`, tenant_id: actor.tenant_id, brand_id: input.brand_id, market: input.market, base_version: current?.version ?? null, proposed, changes, justification: justification.trim(), status: 'pending', proposed_by: actor.id, proposed_at: this.#clock.now().toISOString() };
    this.#proposals.set(p.id, p);
    this.#audit.record(actor.tenant_id, actor.id, 'policy.proposed', `${p.market}/${p.brand_id}`, { proposal: p.id, base_version: p.base_version, loosens: changes.filter((c) => c.loosens).map((c) => c.field) });
    return p;
  }

  decide(actor: { id: string; tenant_id: string }, id: string, approve: boolean, reason = ''): PolicyProposal {
    const p = this.#proposals.get(id);
    if (!p || p.tenant_id !== actor.tenant_id) throw new DomainError('not_found', `No existe la propuesta ${id}.`);
    if (p.status !== 'pending') throw new DomainError('invalid_state', 'La propuesta ya fue decidida.');
    if (p.proposed_by === actor.id) throw new DomainError('segregation_of_duties', 'Quien propone el cambio no puede aprobarlo.');
    const now = this.#clock.now().toISOString();
    const current = this.#policy.listPolicies(actor.tenant_id).find((x) => x.brand_id === p.brand_id && x.market === p.market);
    if (approve && (current?.version ?? null) !== p.base_version) {
      p.status = 'superseded'; p.decided_at = now; p.decided_by = actor.id;
      this.#audit.record(actor.tenant_id, actor.id, 'policy.superseded', `${p.market}/${p.brand_id}`, { proposal: id, base_version: p.base_version, current: current?.version ?? null });
      throw new DomainError('stale_proposal', `Se aprobó otra versión (${current?.version}) después de esta propuesta. Créala de nuevo sobre la vigente.`);
    }
    if (!approve && reason.trim().length < 5) throw new DomainError('reason_required', 'Indica por qué se rechaza (mínimo 5 caracteres).');
    p.status = approve ? 'approved' : 'rejected'; p.decided_by = actor.id; p.decided_at = now;
    if (approve) {
      this.#policy.setPolicy(actor.tenant_id, p.proposed);
      const k = `${actor.tenant_id}::${p.brand_id}::${p.market}`;
      this.#history.set(k, [...(this.#history.get(k) ?? []), { version: p.proposed.version, approved_by: actor.id, at: now, proposal_id: id }]);
    } else p.reject_reason = reason.trim();
    this.#audit.record(actor.tenant_id, actor.id, approve ? 'policy.approved' : 'policy.rejected', `${p.market}/${p.brand_id}`, { proposal: id, version: p.proposed.version, ...(approve ? {} : { reason: p.reject_reason }) });
    return p;
  }
}

import type { AuditLog } from '../audit/audit.ts';
import { DomainError, sha256, type Clock } from '../shared/util.ts';
import { hasIncentive, validateJourney, type JourneyDefinition } from './model.ts';

export type Role = 'crm_analyst' | 'approver' | 'support' | 'rg_officer' | 'tenant_admin' | 'auditor' | 'copilot';
/** `scopes`: solo en llaves de servicio (máquina a máquina); las personas usan roles. */
export type Actor = { id: string; tenant_id: string; roles: Role[]; scopes?: string[] };

const deepFreeze = <T,>(o: T): T => { Object.values(o as object).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };

/**
 * Versionado de recorridos: borradores editables, aprobación separada (autor ≠ aprobador,
 * obligatoria con incentivos), publicación inmutable y firma sobre versión+contenido.
 */
export class JourneyRegistry {
  #versions = new Map<string, JourneyDefinition[]>(); // tenant::id → versions
  #audit: AuditLog;
  #clock: Clock;
  constructor(audit: AuditLog, clock: Clock) { this.#audit = audit; this.#clock = clock; }

  #key(tenant: string, id: string) { return `${tenant}::${id}`; }
  #assertTenant(actor: Actor, tenant: string) { if (actor.tenant_id !== tenant) throw new DomainError('tenant_mismatch', 'cross-tenant access denied'); }
  #need(actor: Actor, ...roles: Role[]) { if (!roles.some((r) => actor.roles.includes(r))) throw new DomainError('forbidden', `requires ${roles.join('|')}`); }

  saveDraft(actor: Actor, input: Omit<JourneyDefinition, 'version' | 'status' | 'created_by' | 'updated_at' | 'tenant_id'>): JourneyDefinition {
    this.#need(actor, 'crm_analyst', 'copilot', 'tenant_admin');
    const k = this.#key(actor.tenant_id, input.id);
    const versions = this.#versions.get(k) ?? [];
    const last = versions.at(-1);
    if (last && last.status === 'draft') versions.pop();
    const draft: JourneyDefinition = { ...structuredClone(input), tenant_id: actor.tenant_id, version: (last && last.status !== 'draft' ? last.version + 1 : last?.version ?? 1), status: 'draft', created_by: actor.id, updated_at: this.#clock.now().toISOString() };
    versions.push(draft);
    this.#versions.set(k, versions);
    this.#audit.record(actor.tenant_id, actor.id, 'journey.draft_saved', `${input.id}@v${draft.version}`, { errors: validateJourney(draft) });
    return draft;
  }

  submit(actor: Actor, id: string): JourneyDefinition {
    const j = this.#latest(actor.tenant_id, id, 'draft');
    this.#assertTenant(actor, j.tenant_id);
    const errs = validateJourney(j);
    if (errs.length) throw new DomainError('invalid_journey', errs.join(','));
    j.status = 'pending_approval';
    this.#audit.record(actor.tenant_id, actor.id, 'journey.submitted', `${id}@v${j.version}`, { incentive: hasIncentive(j) });
    return j;
  }

  approve(actor: Actor, id: string): JourneyDefinition {
    this.#need(actor, 'approver');
    const j = this.#latest(actor.tenant_id, id, 'pending_approval');
    if (j.created_by === actor.id) throw new DomainError('segregation_of_duties', 'author cannot approve own journey');
    j.status = 'approved';
    j.approved_by = actor.id;
    j.approval_signature = sha256(JSON.stringify({ id: j.id, version: j.version, nodes: j.nodes, trigger: j.trigger, purpose: j.purpose, approver: actor.id }));
    this.#audit.record(actor.tenant_id, actor.id, 'journey.approved', `${id}@v${j.version}`, { signature: j.approval_signature });
    return j;
  }

  publish(actor: Actor, id: string): JourneyDefinition {
    this.#need(actor, 'crm_analyst', 'tenant_admin', 'approver');
    const versions = this.#versions.get(this.#key(actor.tenant_id, id)) ?? [];
    const j = versions.at(-1);
    if (!j || j.status !== 'approved') throw new DomainError('not_approved', 'journey must be approved before publish');
    const expected = sha256(JSON.stringify({ id: j.id, version: j.version, nodes: j.nodes, trigger: j.trigger, purpose: j.purpose, approver: j.approved_by }));
    if (expected !== j.approval_signature) throw new DomainError('signature_mismatch', 'content changed after approval');
    for (const v of versions) if (v.status === 'published' || v.status === 'paused') v.status = 'archived';
    const published = deepFreeze({ ...structuredClone(j), status: 'published' as const, updated_at: this.#clock.now().toISOString() });
    versions[versions.length - 1] = published;
    this.#audit.record(actor.tenant_id, actor.id, 'journey.published', `${id}@v${j.version}`, {});
    return published;
  }

  setPaused(actor: Actor, id: string, paused: boolean, reason: string): JourneyDefinition {
    this.#need(actor, 'crm_analyst', 'tenant_admin', 'rg_officer', 'approver');
    const versions = this.#versions.get(this.#key(actor.tenant_id, id)) ?? [];
    const idx = versions.findIndex((v) => v.status === (paused ? 'published' : 'paused'));
    if (idx < 0) throw new DomainError('not_found', `no ${paused ? 'published' : 'paused'} version`);
    const next = deepFreeze({ ...structuredClone(versions[idx]), status: paused ? ('paused' as const) : ('published' as const) });
    versions[idx] = next;
    this.#audit.record(actor.tenant_id, actor.id, paused ? 'journey.paused' : 'journey.resumed', `${id}@v${next.version}`, { reason });
    return next;
  }

  #latest(tenant: string, id: string, status: JourneyDefinition['status']): JourneyDefinition {
    const j = this.#versions.get(this.#key(tenant, id))?.at(-1);
    if (!j || j.status !== status) throw new DomainError('invalid_state', `expected ${status}`);
    return j;
  }

  get(tenant: string, id: string, version: number): JourneyDefinition | undefined {
    return this.#versions.get(this.#key(tenant, id))?.find((v) => v.version === version);
  }
  live(tenant: string): JourneyDefinition[] {
    return [...this.#versions.values()].flat().filter((v) => v.tenant_id === tenant && (v.status === 'published' || v.status === 'paused'));
  }
  list(tenant: string): JourneyDefinition[] {
    return [...this.#versions.values()].flat().filter((v) => v.tenant_id === tenant);
  }
  isPaused(tenant: string, id: string, version: number): boolean { return this.get(tenant, id, version)?.status !== 'published'; }
}

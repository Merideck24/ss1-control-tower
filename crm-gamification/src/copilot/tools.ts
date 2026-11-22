import type { EventEnvelope } from '../domain/events.ts';
import { validateJourney, type JourneyDefinition, type JourneyNode } from '../journeys/model.ts';
import type { Actor, JourneyRegistry } from '../journeys/registry.ts';
import { simulateJourney } from '../journeys/runtime.ts';
import type { PolicyEngine } from '../policy/policyEngine.ts';
import { emptyProfile, type PlayerProfile } from '../profile/projection.ts';
import { runSegment, validateRules, SEGMENT_FIELDS, type RuleNode } from '../segments/segmentEngine.ts';
import type { AuditLog } from '../audit/audit.ts';
import type { Clock } from '../shared/util.ts';
import { DomainError } from '../shared/util.ts';

/** Sesión del copiloto: tenant y rol los fija el backend, nunca el modelo. */
export type CopilotSession = { tenant_id: string; operator_id: string; roles: ('crm_analyst' | 'approver' | 'support' | 'auditor')[] };

type JsonSchema = { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
export type ToolDef = { name: string; description: string; input_schema: JsonSchema; roles: CopilotSession['roles']; writes: 'none' | 'draft' };

/** Umbral de k-anonimato para cifras agregadas. */
const K_MIN = 5;
const bucket = (n: number) => (n > 0 && n < K_MIN ? `<${K_MIN}` : n);

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'query_metric',
    description: 'Devuelve una métrica agregada del catálogo para el tenant de la sesión. Nunca devuelve datos individuales. Métricas: players_total, kyc_verified_rate, deposits_total, rg_restricted_count, marketing_email_optin_rate, suppressions_by_reason.',
    input_schema: { type: 'object', properties: { metric: { type: 'string', enum: ['players_total', 'kyc_verified_rate', 'deposits_total', 'rg_restricted_count', 'marketing_email_optin_rate', 'suppressions_by_reason'] } }, required: ['metric'], additionalProperties: false },
    roles: ['crm_analyst', 'approver', 'auditor'], writes: 'none',
  },
  {
    name: 'preview_segment',
    description: `Estima el tamaño de un segmento (reglas AND/OR/NOT) sin devolver IDs. Campos permitidos: ${SEGMENT_FIELDS.join(', ')}.`,
    input_schema: { type: 'object', properties: { rules: { type: 'object' }, exclusions: { type: 'object' } }, required: ['rules'], additionalProperties: false },
    roles: ['crm_analyst', 'approver'], writes: 'none',
  },
  {
    name: 'validate_policy',
    description: 'Valida la estructura de un borrador de recorrido y lista las políticas aplicables (aprobación por incentivo, canales). El motor de reglas tiene la autoridad de bloqueo final.',
    input_schema: { type: 'object', properties: { journey: { type: 'object' } }, required: ['journey'], additionalProperties: false },
    roles: ['crm_analyst', 'approver'], writes: 'none',
  },
  {
    name: 'simulate_journey',
    description: 'Simula un borrador contra un perfil sintético, sin efectos externos. Devuelve la traza con decisiones de política.',
    input_schema: { type: 'object', properties: { journey: { type: 'object' }, synthetic_profile: { type: 'object', properties: { kyc: { type: 'string' }, rg: { type: 'string' }, country: { type: 'string' }, marketing_email: { type: 'boolean' }, marketing_inapp: { type: 'boolean' } }, additionalProperties: false } }, required: ['journey'], additionalProperties: false },
    roles: ['crm_analyst'], writes: 'none',
  },
  {
    name: 'save_draft',
    description: 'Guarda un borrador de recorrido para revisión humana. No publica, no envía y no otorga recompensas.',
    input_schema: { type: 'object', properties: { journey: { type: 'object' } }, required: ['journey'], additionalProperties: false },
    roles: ['crm_analyst'], writes: 'draft',
  },
];

/** Cualquier tenant_id/brand-scoped id en la entrada debe coincidir con la sesión. */
function referencesOtherTenant(v: unknown, tenant: string): boolean {
  if (Array.isArray(v)) return v.some((x) => referencesOtherTenant(x, tenant));
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => (k === 'tenant_id' && x !== tenant) || referencesOtherTenant(x, tenant));
  return false;
}

export type ToolResult = { ok: true; data: unknown; data_as_of: string; tool: string } | { ok: false; error: string; tool: string };

type Deps = { registry: JourneyRegistry; policy: PolicyEngine; profiles: () => readonly PlayerProfile[]; audit: AuditLog; clock: Clock };

/**
 * Despachador de herramientas: valida nombre, rol, esquema y fronteras de tenant
 * en cada llamada. El conjunto carece de herramientas para enviar, publicar,
 * otorgar premios o cambiar restricciones.
 */
export class CopilotTools {
  #d: Deps;
  constructor(deps: Deps) { this.#d = deps; }

  definitionsFor(s: CopilotSession) { return TOOL_DEFS.filter((t) => t.roles.some((r) => s.roles.includes(r))); }

  call(s: CopilotSession, name: string, input: unknown): ToolResult {
    const def = TOOL_DEFS.find((t) => t.name === name);
    const fail = (error: string): ToolResult => { this.#d.audit.record(s.tenant_id, `copilot:${s.operator_id}`, 'copilot.tool_denied', name, { error }); return { ok: false, error, tool: name }; };
    if (!def) return fail('unknown_tool');
    if (!def.roles.some((r) => s.roles.includes(r))) return fail('insufficient_role');
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('invalid_input');
    const obj = input as Record<string, unknown>;
    for (const k of Object.keys(obj)) if (!(k in def.input_schema.properties)) return fail(`unexpected_field:${k}`);
    for (const k of def.input_schema.required) if (!(k in obj)) return fail(`missing_field:${k}`);
    if (referencesOtherTenant(obj, s.tenant_id)) return fail('cross_tenant_reference');
    try {
      const data = this.#exec(s, name, obj);
      this.#d.audit.record(s.tenant_id, `copilot:${s.operator_id}`, 'copilot.tool_call', name, { writes: def.writes });
      return { ok: true, data, data_as_of: this.#d.clock.now().toISOString(), tool: name };
    } catch (e) {
      return fail((e as Error).message);
    }
  }

  #scoped(s: CopilotSession) { return this.#d.profiles().filter((p) => p.tenant_id === s.tenant_id); }

  #journeyFrom(s: CopilotSession, raw: unknown): JourneyDefinition {
    const j = raw as Partial<JourneyDefinition>;
    if (!j?.id || !j.trigger || !j.entry || !Array.isArray(j.nodes) || !j.purpose) throw new DomainError('invalid_journey', 'requires id, purpose, trigger, entry, nodes');
    return { brand_id: 'rumbawin', name: j.id, ...j, tenant_id: s.tenant_id, version: 0, status: 'draft', created_by: `copilot:${s.operator_id}`, updated_at: this.#d.clock.now().toISOString() } as JourneyDefinition;
  }

  #exec(s: CopilotSession, name: string, input: Record<string, unknown>): unknown {
    const ps = this.#scoped(s);
    switch (name) {
      case 'query_metric': {
        const n = ps.length;
        const metric = input.metric as string;
        const def = { players_total: 'Jugadores con perfil proyectado', kyc_verified_rate: 'Verificados / total', deposits_total: 'Suma de depósitos liquidados netos de reversos (unidades mínimas)', rg_restricted_count: 'Jugadores con restricción JR activa', marketing_email_optin_rate: 'Opt-in marketing email / total', suppressions_by_reason: 'Supresiones auditadas por motivo' }[metric];
        let value: unknown;
        if (metric === 'players_total') value = bucket(n);
        if (metric === 'kyc_verified_rate') value = n < K_MIN ? 'insufficient_data' : +(ps.filter((p) => p.kyc?.value === 'verified').length / n).toFixed(3);
        if (metric === 'deposits_total') {
          const byCur: Record<string, number> = {};
          for (const p of ps) if (p.stats.currency) byCur[p.stats.currency] = (byCur[p.stats.currency] ?? 0) + p.stats.deposits_minor;
          value = n < K_MIN ? 'insufficient_data' : byCur;
        }
        if (metric === 'rg_restricted_count') value = bucket(ps.filter((p) => p.rg && p.rg.value !== 'none').length);
        if (metric === 'marketing_email_optin_rate') value = n < K_MIN ? 'insufficient_data' : +(ps.filter((p) => p.consents['marketing:email']?.value).length / n).toFixed(3);
        if (metric === 'suppressions_by_reason') {
          const counts: Record<string, number> = {};
          for (const e of this.#d.audit.list(s.tenant_id, { action: 'delivery.suppressed' })) for (const r of (e.details.reasons as string[]) ?? []) counts[r] = (counts[r] ?? 0) + 1;
          value = counts;
        }
        return { metric, definition: def, value, population: bucket(n) };
      }
      case 'preview_segment': {
        const rules = input.rules as RuleNode;
        const errs = [...validateRules(rules), ...(input.exclusions ? validateRules(input.exclusions as RuleNode) : [])];
        if (errs.length) throw new DomainError('invalid_rules', errs.join(','));
        const r = runSegment({ id: 'preview', tenant_id: s.tenant_id, name: 'preview', version: 0, rules, exclusions: input.exclusions as RuleNode | undefined }, ps, this.#d.clock.now());
        return { estimated_size: bucket(r.members.length), excluded: bucket(r.excluded.length), universe: bucket(r.universe), snapshot_hash: r.snapshot_hash };
      }
      case 'validate_policy': {
        const j = this.#journeyFrom(s, input.journey);
        const errors = validateJourney(j);
        const incentive = j.nodes.some((n: JourneyNode) => n.type === 'grant_reward');
        return { valid: errors.length === 0, errors, findings: [incentive ? 'Contiene incentivo: requiere aprobación separada (autor ≠ aprobador).' : 'Sin incentivos.', j.purpose === 'service' ? 'Mensaje de servicio: política propia, fuera del grupo de control.' : 'Marketing: consentimiento, JR, frecuencia y horario se revalidan al ejecutar.'], requires_approval: true };
      }
      case 'simulate_journey': {
        const j = this.#journeyFrom(s, input.journey);
        const sp = (input.synthetic_profile ?? {}) as Record<string, unknown>;
        const now = this.#d.clock.now().toISOString();
        const tr = (v: unknown) => ({ value: v, source: 'synthetic', occurred_at: now, event_id: 'synthetic', version: 1 });
        const profile: PlayerProfile = { ...emptyProfile(s.tenant_id, j.brand_id, 'synthetic-player'), kyc: tr(sp.kyc ?? 'verified') as never, rg: tr(sp.rg ?? 'none') as never, country: tr(sp.country ?? 'CO') as never, timezone: tr('America/Bogota') as never, locale: tr('es') as never, consents: { 'marketing:email': tr(sp.marketing_email ?? true) as never, 'marketing:inapp': tr(sp.marketing_inapp ?? true) as never } };
        const trigger = { event_id: 'sim-trigger', event_type: j.trigger.event_type, schema_version: 1, tenant_id: s.tenant_id, brand_id: j.brand_id, player_id: profile.player_id, occurred_at: now, source: 'simulator', correlation_id: 'sim', payload: {} } as unknown as EventEnvelope;
        return simulateJourney(j, profile, trigger, { policy: this.#d.policy, audit: this.#d.audit, clock: this.#d.clock });
      }
      case 'save_draft': {
        const j = this.#journeyFrom(s, input.journey);
        const actor: Actor = { id: `copilot:${s.operator_id}`, tenant_id: s.tenant_id, roles: ['copilot'] };
        const { version: _v, status: _s, created_by: _c, updated_at: _u, tenant_id: _t, approved_by: _a, approval_signature: _sig, ...rest } = j;
        const saved = this.#d.registry.saveDraft(actor, rest);
        return { id: saved.id, version: saved.version, status: saved.status, validation_errors: validateJourney(saved), next_step: 'Revisión humana y aprobación en el Centro de aprobación' };
      }
    }
    throw new DomainError('unknown_tool', name);
  }
}

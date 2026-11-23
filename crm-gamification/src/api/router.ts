import { ev, type App } from '../app.ts';
import type { CopilotSession, CopilotTools } from '../copilot/tools.ts';
import { report } from '../experiments/experiments.ts';
import { journeyAsList, validateJourney } from '../journeys/model.ts';
import type { Actor, Role } from '../journeys/registry.ts';
import { simulateJourney } from '../journeys/runtime.ts';
import { profileView } from '../profile/projection.ts';
import { runSegment, validateRules, SEGMENT_FIELDS } from '../segments/segmentEngine.ts';
import { DomainError, HOUR } from '../shared/util.ts';

export type ApiRequest = { method: string; path: string; query: URLSearchParams; headers: Record<string, string | undefined>; body: Record<string, unknown> };
export type ApiResponse = { status: number; body: unknown };
export type AskFn = (tools: CopilotTools, session: CopilotSession, question: string) => Promise<unknown>;

/** Permisos por acción (RBAC). La interfaz los usa para mostrar solo lo permitido. */
export const PERMISSIONS: Record<string, Role[]> = {
  'journeys.draft': ['crm_analyst', 'tenant_admin'],
  'journeys.submit': ['crm_analyst', 'tenant_admin'],
  'journeys.approve': ['approver'],
  'journeys.publish': ['crm_analyst', 'tenant_admin', 'approver'],
  'journeys.pause': ['crm_analyst', 'tenant_admin', 'rg_officer', 'approver'],
  'journeys.simulate': ['crm_analyst', 'approver', 'tenant_admin'],
  'runtime.tick': ['crm_analyst', 'tenant_admin', 'rg_officer'],
  'runtime.global_pause': ['tenant_admin', 'rg_officer'],
  'players.read': ['crm_analyst', 'approver', 'support', 'rg_officer', 'tenant_admin', 'auditor'],
  'segments.preview': ['crm_analyst', 'approver', 'tenant_admin'],
  'rewards.reconcile': ['tenant_admin', 'approver'],
  'analytics.read': ['crm_analyst', 'approver', 'tenant_admin', 'auditor'],
  'performance.read': ['crm_analyst', 'approver', 'tenant_admin', 'auditor'],
  'audit.read': ['auditor', 'tenant_admin', 'approver'],
};

const can = (a: Actor, perm: string) => PERMISSIONS[perm]?.some((r) => a.roles.includes(r)) ?? false;
const forbid = (perm: string): ApiResponse => ({ status: 403, body: { error: 'forbidden', message: `Tu rol no tiene permiso para esta acción. Roles con permiso: ${PERMISSIONS[perm].join(', ')}` } });

/**
 * Sesión de desarrollo vía cabeceras (x-tenant-id, x-actor, x-roles).
 * En producción se reemplaza por el servicio de identidad SS1 (OIDC) y RBAC central.
 */
export function sessionFrom(headers: ApiRequest['headers']): Actor {
  const tenant_id = String(headers['x-tenant-id'] ?? 'tenant-rumbawin');
  const id = String(headers['x-actor'] ?? 'analyst@ss1');
  const roles = String(headers['x-roles'] ?? 'crm_analyst').split(',').map((r) => r.trim()) as Role[];
  return { id, tenant_id, roles };
}

export function controlTower(app: App, tenant: string) {
  const instances = app.runtime.instances(tenant);
  const receipts = app.channels.receipts(tenant);
  const count = <T,>(xs: T[], f: (x: T) => string) => xs.reduce<Record<string, number>>((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
  return {
    as_of: app.clock.now().toISOString(),
    global_pause: app.runtime.isGloballyPaused(tenant),
    journeys: app.registry.list(tenant).map((j) => ({ id: j.id, name: j.name, version: j.version, status: j.status, purpose: j.purpose, control_group_pct: j.control_group_pct ?? 0, instances: count(instances.filter((i) => i.journey_id === j.id && i.version === j.version), (i) => i.status) })),
    deliveries: count(receipts, (r) => `${r.channel}:${r.status}`),
    suppression_reasons: count(receipts.filter((r) => r.status === 'suppressed').flatMap((r) => (r.reason ?? '').split(',')), (x) => x),
    deferred: receipts.filter((r) => r.status === 'deferred').length,
    failures: receipts.filter((r) => r.status === 'failed').slice(-10),
    budgets: app.rewards.catalog(tenant).map((i) => ({ reward_id: i.id, ...app.rewards.budget(tenant, i.id) })),
    alerts: app.policy.alerts().filter((a) => a.tenant_id === tenant).slice(-10),
    dead_letters: app.ingestor.deadLetters().length,
    source_metrics: app.ingestor.sourceMetrics(),
  };
}

/** Enrutador puro: lo usan el servidor HTTP y la versión estática en navegador. */
export async function route(app: App, req: ApiRequest, opts: { ask?: AskFn } = {}): Promise<ApiResponse> {
  const actor = sessionFrom(req.headers);
  const T = actor.tenant_id;
  const ok = (body: unknown, status = 200): ApiResponse => ({ status, body });
  const r0 = `${req.method} ${req.path}`;
  const m = (pattern: RegExp) => r0.match(pattern);
  let r: RegExpMatchArray | null;
  try {
    if (!app.tenants.includes(T)) return { status: 403, body: { error: 'tenant_unknown', message: `Tenant ${T} no habilitado` } };
    if (r0 === 'GET /health') return ok({ ok: true });
    if (r0 === 'GET /session') return ok({ actor, permissions: Object.keys(PERMISSIONS).filter((p) => can(actor, p)), copilot_tools: app.copilot.definitionsFor(copilotSession(actor)).map((t) => t.name), copilot_ask: Boolean(opts.ask) });
    if (r0 === 'GET /control-tower') return ok(controlTower(app, T));
    if (r0 === 'POST /events') {
      if (req.body.tenant_id !== T) return { status: 403, body: { error: 'tenant_mismatch' } };
      const out = app.ingestor.ingest(req.body);
      return ok({ status: out.status, reason: out.reason }, out.status === 'rejected' ? 422 : 202);
    }
    if (r0 === 'GET /players') {
      if (!can(actor, 'players.read')) return forbid('players.read');
      const q = req.query.get('q') ?? '';
      return ok(app.ingestor.all(T).filter((p) => p.player_id.includes(q)).slice(0, 100).map((p) => ({ player_id: p.player_id, kyc: p.kyc?.value, rg: p.rg?.value, deposits_minor: p.stats.deposits_minor, currency: p.stats.currency, level: app.loyalty.program(T, p.brand_id) ? app.loyalty.progress(T, p.brand_id, p.player_id).level : null })));
    }
    if ((r = m(/^GET \/players\/([\w-]+)$/))) {
      if (!can(actor, 'players.read')) return forbid('players.read');
      const p = app.ingestor.get(T, r[1]);
      if (!p) return { status: 404, body: { error: 'not_found', message: `No existe el jugador ${r[1]} en ${T}` } };
      const decisions = Object.fromEntries((['inapp', 'email', 'webpush'] as const).map((c) => [c, app.policy.decide({ profile: p, purpose: 'marketing', channel: c })]));
      return ok({
        profile: profileView(p),
        loyalty: app.loyalty.program(T, p.brand_id) ? { ...app.loyalty.progress(T, p.brand_id, p.player_id), movements: app.loyalty.movements(T, p.player_id).slice(-20) } : null,
        eligibility_explanation: { marketing: decisions, incentive: app.policy.decide({ profile: p, purpose: 'marketing', incentive: true }) },
        receipts: app.channels.receipts(T, p.player_id),
        journeys: app.runtime.instances(T, { player_id: p.player_id }),
        grants: app.rewards.grants(T).filter((g) => g.player_id === p.player_id),
      });
    }
    if (r0 === 'GET /segments/fields') return ok(SEGMENT_FIELDS);
    if (r0 === 'POST /segments/preview') {
      if (!can(actor, 'segments.preview')) return forbid('segments.preview');
      const b = req.body;
      const errs = [...validateRules(b.rules as never), ...(b.exclusions ? validateRules(b.exclusions as never) : [])];
      if (errs.length) return { status: 422, body: { error: 'invalid_rules', message: errs.join(', '), errors: errs } };
      const out = runSegment({ id: 'preview', tenant_id: T, name: 'preview', version: 0, rules: b.rules as never, exclusions: b.exclusions as never }, app.ingestor.all(T), app.clock.now());
      return ok({ size: out.members.length, excluded: out.excluded.length, universe: out.universe, snapshot_hash: out.snapshot_hash, sample: out.members.slice(0, 10) });
    }
    if (r0 === 'GET /journeys') return ok(app.registry.list(T).map((j) => ({ ...j, as_list: journeyAsList(j), validation: validateJourney(j) })));
    if (r0 === 'POST /journeys') {
      if (!can(actor, 'journeys.draft')) return forbid('journeys.draft');
      return ok(app.registry.saveDraft(actor, req.body as never), 201);
    }
    if ((r = m(/^POST \/journeys\/([\w-]+)\/(submit|approve|publish|pause|resume)$/))) {
      const [, id, action] = r;
      const perm = `journeys.${action === 'resume' ? 'pause' : action}`;
      if (!can(actor, perm)) return forbid(perm);
      const out = action === 'submit' ? app.registry.submit(actor, id) : action === 'approve' ? app.registry.approve(actor, id) : action === 'publish' ? app.registry.publish(actor, id) : app.registry.setPaused(actor, id, action === 'pause', String(req.body.reason ?? 'manual'));
      return ok(out);
    }
    if ((r = m(/^POST \/journeys\/([\w-]+)\/simulate$/))) {
      if (!can(actor, 'journeys.simulate')) return forbid('journeys.simulate');
      const def = app.registry.list(T).filter((j) => j.id === r![1]).at(-1);
      const p = app.ingestor.get(T, String(req.body.player_id));
      if (!def || !p) return { status: 404, body: { error: 'not_found', message: 'Recorrido o jugador inexistente' } };
      return ok(simulateJourney(def, p, ev(T, p.player_id, def.trigger.event_type, (req.body.payload ?? {}) as never, app.clock.now().toISOString(), { source: 'simulator' }), { policy: app.policy, audit: app.audit, clock: app.clock }));
    }
    if (r0 === 'POST /runtime/tick') {
      if (!can(actor, 'runtime.tick')) return forbid('runtime.tick');
      const hours = Number(req.body.advance_hours ?? 0);
      if (hours > 0) (app.clock as { advance?: (ms: number) => void }).advance?.(Math.min(hours, 72) * HOUR);
      for (const t of app.tenants) app.policy.markRgFeedSynced(t); // demo: latido del feed JR tras adelantar el reloj
      return ok({ processed: app.runtime.runDue(), now: app.clock.now().toISOString() });
    }
    if (r0 === 'POST /runtime/pause') {
      if (!can(actor, 'runtime.global_pause')) return forbid('runtime.global_pause');
      app.runtime.setGlobalPause(T, Boolean(req.body.paused), actor.id, String(req.body.reason ?? 'manual'));
      return ok({ global_pause: app.runtime.isGloballyPaused(T) });
    }
    if (r0 === 'GET /rewards') return ok({ catalog: app.rewards.catalog(T).map((i) => ({ ...i, budget: app.rewards.budget(T, i.id) })), grants: app.rewards.grants(T).slice(-50) });
    if (r0 === 'POST /rewards/reconcile') {
      if (!can(actor, 'rewards.reconcile')) return forbid('rewards.reconcile');
      return ok(app.rewards.reconcile(T));
    }
    if (r0 === 'GET /analytics/campaigns') {
      if (!can(actor, 'analytics.read')) return forbid('analytics.read');
      return ok(app.registry.live(T).filter((j) => j.purpose === 'marketing').map((j) => {
        const inst = app.runtime.instances(T, { journey_id: j.id });
        const conv = (arm: string) => inst.filter((i) => i.arm === arm && (app.ingestor.get(T, i.player_id)?.stats.deposit_count ?? 0) > 0).length;
        const cost = app.rewards.grants(T).filter((g) => g.status === 'confirmed' && g.idempotency_key.includes(`:${j.id}:`)).reduce((s, g) => s + g.value.amount_minor, 0);
        return report({ campaign: j.id, window: { from: j.updated_at, to: app.clock.now().toISOString() }, primary_metric: 'has_deposit', treatment: { n: inst.filter((i) => i.arm === 'treatment').length, conversions: conv('treatment') }, control: { n: inst.filter((i) => i.arm === 'control').length, conversions: conv('control') }, cost_minor: cost, currency: 'COP' });
      }));
    }
    if (r0 === 'GET /performance') {
      if (!can(actor, 'performance.read')) return forbid('performance.read');
      const days = Math.min(365, Math.max(1, Number(req.query.get('days') ?? 30)));
      return ok(app.performanceReport(T, days));
    }
    if (r0 === 'GET /audit') {
      if (!can(actor, 'audit.read')) return forbid('audit.read');
      return ok({ chain_valid: app.audit.verifyChain(), entries: app.audit.list(T).slice(-200) });
    }
    if (r0 === 'GET /copilot/tools') return ok(app.copilot.definitionsFor(copilotSession(actor)));
    if ((r = m(/^POST \/copilot\/tools\/(\w+)$/))) return ok(app.copilot.call(copilotSession(actor), r[1], req.body));
    if (r0 === 'POST /copilot/ask') {
      if (!opts.ask) return ok({ answer: 'El copiloto en lenguaje natural no está disponible en esta versión. Usa las herramientas directas de abajo.', tool_calls: [], stop_reason: 'not_configured' });
      return ok(await opts.ask(app.copilot, copilotSession(actor), String(req.body.question ?? '')));
    }
    return { status: 404, body: { error: 'route_not_found', message: r0 } };
  } catch (e) {
    const err = e as DomainError;
    const status = ['forbidden', 'tenant_mismatch', 'segregation_of_duties'].includes(err.code) ? 403 : err.code ? 422 : 500;
    return { status, body: { error: err.code ?? 'internal_error', message: err.message } };
  }
}

export function copilotSession(actor: Actor): CopilotSession {
  return { tenant_id: actor.tenant_id, operator_id: actor.id, roles: actor.roles.filter((x) => ['crm_analyst', 'approver', 'support', 'auditor'].includes(x)) as CopilotSession['roles'] };
}

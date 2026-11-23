import { ev, type App } from '../app.ts';
import type { CopilotSession, CopilotTools } from '../copilot/tools.ts';
import { report } from '../experiments/experiments.ts';
import { journeyAsList, validateJourney } from '../journeys/model.ts';
import type { Actor, Role } from '../journeys/registry.ts';
import { simulateJourney } from '../journeys/runtime.ts';
import { profileView } from '../profile/projection.ts';
import { runSegment, validateRules, SEGMENT_FIELDS } from '../segments/segmentEngine.ts';
import { DomainError, HOUR } from '../shared/util.ts';
import { computeRfm, distribution, lifecycleOf, LIFECYCLE_LABELS, RFM_LABELS } from '../analytics/rfm.ts';
import { Ss1Client } from '../integration/ss1Client.ts';
import { mapTriggerCatalog, runConnector, SS1_ENDPOINTS } from '../integration/ss1Connectors.ts';
import { deriveBrandTokens, parseThemeConfig } from '../integration/theme.ts';

const THEME_CACHE = new Map<string, { until: number; body: unknown }>();

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
  'alerts.read': ['crm_analyst', 'approver', 'tenant_admin', 'auditor', 'rg_officer'],
  'alerts.ack': ['crm_analyst', 'approver', 'tenant_admin', 'rg_officer'],
  'alerts.configure': ['tenant_admin'],
  'integration.sync': ['tenant_admin'],
  'integration.read': ['crm_analyst', 'approver', 'tenant_admin'],
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
/** `ss1` lo entrega el servidor cuando la petición trae un token del admin ya validado. */
export type Ss1Context = { apiBase: string; token: string; fetchImpl?: typeof fetch };

export async function route(app: App, req: ApiRequest, opts: { ask?: AskFn; actor?: Actor; ss1?: Ss1Context } = {}): Promise<ApiResponse> {
  // con identidad SS1 el servidor entrega el actor ya validado; las cabeceras solo valen en desarrollo/demo
  const actor = opts.actor ?? sessionFrom(req.headers);
  const T = actor.tenant_id;
  const ok = (body: unknown, status = 200): ApiResponse => ({ status, body });
  let path = req.path;
  try { path = decodeURIComponent(req.path); } catch { /* ruta mal codificada: se usa tal cual */ }
  const r0 = `${req.method} ${path}`;
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
        segmentation: (() => {
          const now = app.clock.now();
          const life = lifecycleOf(p, now);
          const s = computeRfm(app.ingestor.all(T), now).get(p.player_id);
          return { lifecycle: { key: life, label: LIFECYCLE_LABELS[life] }, rfm: s ? { ...s, label: RFM_LABELS[s.segment] } : null, predictions: app.models(T).predictions.get(p.player_id) ?? null };
        })(),
      });
    }
    if (r0 === 'GET /segments/fields') return ok(SEGMENT_FIELDS);
    if (r0 === 'GET /models') {
      if (!can(actor, 'analytics.read')) return forbid('analytics.read');
      const m = app.models(T);
      const preds = [...m.predictions.values()];
      return ok({ as_of: m.as_of, models: m.models, value: m.value, vip_threshold_minor: m.vip_threshold_minor, notes: m.notes,
        summary: { scored: preds.length, high_churn: preds.filter((p) => (p.churn?.p ?? 0) >= 0.6).length, vip_early: preds.filter((p) => p.vip_early).length, not_promo_eligible: preds.filter((p) => !p.promo_eligible).length } });
    }
    if (r0 === 'GET /segments/rfm') {
      if (!can(actor, 'segments.preview')) return forbid('segments.preview');
      return ok(distribution(app.ingestor.all(T), app.clock.now()));
    }
    if (r0 === 'POST /segments/preview') {
      if (!can(actor, 'segments.preview')) return forbid('segments.preview');
      const b = req.body;
      const errs = [...validateRules(b.rules as never), ...(b.exclusions ? validateRules(b.exclusions as never) : [])];
      if (errs.length) return { status: 422, body: { error: 'invalid_rules', message: errs.join(', '), errors: errs } };
      const needsPred = JSON.stringify([b.rules, b.exclusions ?? null]).includes('"pred.');
      const out = runSegment({ id: 'preview', tenant_id: T, name: 'preview', version: 0, rules: b.rules as never, exclusions: b.exclusions as never }, app.ingestor.all(T), app.clock.now(), needsPred ? { predict: (id) => app.models(T).predictions.get(id) } : {});
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
    if (r0 === 'GET /performance/payback') {
      if (!can(actor, 'performance.read')) return forbid('performance.read');
      const weeks = Math.min(26, Math.max(1, Number(req.query.get('weeks') ?? 12)));
      return ok(app.performance.payback(T, { to: app.clock.now(), weeks }));
    }
    if (r0 === 'GET /kpi-alerts') {
      if (!can(actor, 'alerts.read')) return forbid('alerts.read');
      return ok({ as_of: app.clock.now().toISOString(), config: app.alertCenter.config(T), alerts: app.kpiAlerts(T) });
    }
    if ((r = m(/^POST \/kpi-alerts\/([\w:.-]+)\/ack$/))) {
      if (!can(actor, 'alerts.ack')) return forbid('alerts.ack');
      const id = r[1];
      if (!app.kpiAlerts(T).some((a) => a.id === id)) return { status: 404, body: { error: 'not_found', message: 'La alerta ya no está activa' } };
      const at = app.clock.now().toISOString();
      app.alertCenter.acknowledge(T, id, actor.id, at, req.body.note ? String(req.body.note).slice(0, 280) : undefined);
      app.audit.record(T, actor.id, 'kpi_alert.acknowledged', id, { note: req.body.note ?? null });
      return ok({ id, acknowledged: { by: actor.id, at } });
    }
    if (r0 === 'PUT /kpi-alerts/config') {
      if (!can(actor, 'alerts.configure')) return forbid('alerts.configure');
      try {
        const next = app.alertCenter.setConfig(T, req.body as never);
        app.audit.record(T, actor.id, 'kpi_alert.config_changed', T, req.body);
        return ok(next);
      } catch (e) { return { status: 422, body: { error: 'invalid_config', message: (e as Error).message } }; }
    }
    if (r0 === 'GET /integration/ss1/theme') {
      if (!opts.ss1) return { status: 409, body: { error: 'not_integrated', message: 'Sin token del admin se usa el tema por defecto de SS1.' } };
      const hit = THEME_CACHE.get(T);
      if (hit && hit.until > Date.now()) return ok(hit.body);
      const client = new Ss1Client({ apiBase: opts.ss1.apiBase, token: opts.ss1.token, fetchImpl: opts.ss1.fetchImpl, retries: 1 });
      let parsed: { primary?: string; logo?: string } = {};
      try { parsed = parseThemeConfig(await client.get('/admin/theme-config')); } catch { /* sin tema del operador: valores de SS1 */ }
      const body = { ...deriveBrandTokens(parsed.primary), logo: parsed.logo ?? null };
      THEME_CACHE.set(T, { until: Date.now() + 5 * 60_000, body });
      return ok(body);
    }
    if (r0 === 'POST /integration/ss1/sync' || r0 === 'GET /integration/ss1/trigger-catalog') {
      const perm = r0.startsWith('POST') ? 'integration.sync' : 'integration.read';
      if (!can(actor, perm)) return forbid(perm);
      if (!opts.ss1) return { status: 409, body: { error: 'not_integrated', message: 'Disponible solo con el CRM integrado a admin.syssoft1.com (token del admin).' } };
      const client = new Ss1Client({ apiBase: opts.ss1.apiBase, token: opts.ss1.token, fetchImpl: opts.ss1.fetchImpl });
      if (r0.startsWith('GET')) return ok({ triggers: mapTriggerCatalog(await client.get(SS1_ENDPOINTS.triggerCatalog)) });
      const wanted = (Array.isArray(req.body.connectors) ? req.body.connectors : ['players', 'financial', 'withdrawals']).filter((c: unknown): c is 'players' | 'financial' | 'withdrawals' => c === 'players' || c === 'financial' || c === 'withdrawals');
      const since = typeof req.body.since === 'string' && !Number.isNaN(Date.parse(req.body.since)) ? req.body.since : undefined;
      const ctx = { tenant_id: T, brand_id: String(req.body.brand_id ?? 'rumbawin') };
      const reports = [];
      // backfill (por defecto): sin recorridos ni bonos para hechos históricos; live: eventos nuevos con efectos
      const mode = req.body.mode === 'live' ? 'live' : 'backfill';
      for (const c of wanted) reports.push(await runConnector(c, client, app.ingestor, ctx, since ? { updated_since: since } : {}, { replay: mode === 'backfill' }));
      app.audit.record(T, actor.id, 'integration.ss1_sync', T, { connectors: wanted, mode, since: since ?? null, reports: reports.map((r) => ({ c: r.connector, fetched: r.fetched, ingested: r.ingested, error: r.error ?? null })) });
      return ok({ mode, requests: client.requests, reports });
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

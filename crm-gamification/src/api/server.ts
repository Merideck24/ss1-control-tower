import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, ev, seedTenant, type App } from '../app.ts';
import { seedDemoPlayers } from '../demoData.ts';
import { askCopilot } from '../copilot/agent.ts';
import type { CopilotSession } from '../copilot/tools.ts';
import { journeyAsList, validateJourney } from '../journeys/model.ts';
import type { Actor, Role } from '../journeys/registry.ts';
import { simulateJourney } from '../journeys/runtime.ts';
import { profileView } from '../profile/projection.ts';
import { runSegment, validateRules, SEGMENT_FIELDS } from '../segments/segmentEngine.ts';
import { report } from '../experiments/experiments.ts';
import { DomainError, HOUR, OffsetClock } from '../shared/util.ts';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), '../../public');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

/**
 * Sesión de desarrollo vía cabeceras (x-tenant-id, x-actor, x-roles).
 * En producción se reemplaza por el servicio de identidad SS1 (OIDC) y RBAC central.
 */
function session(req: IncomingMessage): Actor {
  const tenant_id = String(req.headers['x-tenant-id'] ?? 'tenant-rumbawin');
  const id = String(req.headers['x-actor'] ?? 'analyst@ss1');
  const roles = String(req.headers['x-roles'] ?? 'crm_analyst').split(',').map((r) => r.trim()) as Role[];
  return { id, tenant_id, roles };
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
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
    failures: receipts.filter((r) => r.status === 'failed').slice(-10),
    budgets: app.rewards.catalog(tenant).map((i) => ({ reward_id: i.id, ...app.rewards.budget(tenant, i.id) })),
    alerts: app.policy.alerts().filter((a) => a.tenant_id === tenant).slice(-10),
    dead_letters: app.ingestor.deadLetters().length,
    source_metrics: app.ingestor.sourceMetrics(),
  };
}

export function createHandler(app: App) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const actor = session(req);
    const T = actor.tenant_id;
    try {
      if (parts[0] !== 'api') {
        const file = normalize(join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
        if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
        const data = await readFile(file).catch(() => null);
        if (!data) return send(res, 404, { error: 'not_found' });
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
        return res.end(data);
      }
      const route = `${req.method} /${parts.slice(1).join('/')}`;
      const m = (pattern: RegExp) => route.match(pattern);
      let r: RegExpMatchArray | null;

      if (route === 'GET /health') return send(res, 200, { ok: true });
      if (route === 'GET /control-tower') return send(res, 200, controlTower(app, T));
      if (route === 'POST /events') {
        const e = await body(req);
        if (e.tenant_id !== T) return send(res, 403, { error: 'tenant_mismatch' });
        const out = app.ingestor.ingest(e);
        return send(res, out.status === 'rejected' ? 422 : 202, { status: out.status, reason: out.reason });
      }
      if (route === 'GET /players') {
        const q = url.searchParams.get('q') ?? '';
        return send(res, 200, app.ingestor.all(T).filter((p) => p.player_id.includes(q)).slice(0, 100).map((p) => ({ player_id: p.player_id, kyc: p.kyc?.value, rg: p.rg?.value, deposits_minor: p.stats.deposits_minor, currency: p.stats.currency, level: app.loyalty.program(T, p.brand_id) ? app.loyalty.progress(T, p.brand_id, p.player_id).level : null })));
      }
      if ((r = m(/^GET \/players\/([\w-]+)$/))) {
        const p = app.ingestor.get(T, r[1]);
        if (!p) return send(res, 404, { error: 'not_found' });
        const decisions = Object.fromEntries((['inapp', 'email', 'webpush'] as const).map((c) => [c, app.policy.decide({ profile: p, purpose: 'marketing', channel: c })]));
        return send(res, 200, {
          profile: profileView(p),
          loyalty: app.loyalty.program(T, p.brand_id) ? { ...app.loyalty.progress(T, p.brand_id, p.player_id), movements: app.loyalty.movements(T, p.player_id).slice(-20) } : null,
          eligibility_explanation: { marketing: decisions, incentive: app.policy.decide({ profile: p, purpose: 'marketing', incentive: true }) },
          receipts: app.channels.receipts(T, p.player_id),
          journeys: app.runtime.instances(T, { player_id: p.player_id }),
          grants: app.rewards.grants(T).filter((g) => g.player_id === p.player_id),
        });
      }
      if (route === 'GET /segments/fields') return send(res, 200, SEGMENT_FIELDS);
      if (route === 'POST /segments/preview') {
        const b = await body(req);
        const errs = [...validateRules(b.rules as never), ...(b.exclusions ? validateRules(b.exclusions as never) : [])];
        if (errs.length) return send(res, 422, { errors: errs });
        const out = runSegment({ id: 'preview', tenant_id: T, name: 'preview', version: 0, rules: b.rules as never, exclusions: b.exclusions as never }, app.ingestor.all(T), app.clock.now());
        return send(res, 200, { size: out.members.length, excluded: out.excluded.length, universe: out.universe, snapshot_hash: out.snapshot_hash, sample: out.members.slice(0, 10) });
      }
      if (route === 'GET /journeys') return send(res, 200, app.registry.list(T).map((j) => ({ ...j, as_list: journeyAsList(j), validation: validateJourney(j) })));
      if (route === 'POST /journeys') return send(res, 201, app.registry.saveDraft(actor, (await body(req)) as never));
      if ((r = m(/^POST \/journeys\/([\w-]+)\/(submit|approve|publish|pause|resume)$/))) {
        const [, id, action] = r;
        const b = await body(req);
        const out = action === 'submit' ? app.registry.submit(actor, id) : action === 'approve' ? app.registry.approve(actor, id) : action === 'publish' ? app.registry.publish(actor, id) : app.registry.setPaused(actor, id, action === 'pause', String(b.reason ?? 'manual'));
        return send(res, 200, out);
      }
      if ((r = m(/^POST \/journeys\/([\w-]+)\/simulate$/))) {
        const b = await body(req);
        const def = app.registry.list(T).filter((j) => j.id === r![1]).at(-1);
        const p = app.ingestor.get(T, String(b.player_id));
        if (!def || !p) return send(res, 404, { error: 'not_found' });
        return send(res, 200, simulateJourney(def, p, ev(T, p.player_id, def.trigger.event_type, (b.payload ?? {}) as never, app.clock.now().toISOString(), { source: 'simulator' }), { policy: app.policy, audit: app.audit, clock: app.clock }));
      }
      if (route === 'POST /runtime/tick') {
        const b = await body(req);
        const hours = Number(b.advance_hours ?? 0);
        if (hours > 0) (app.clock as { advance?: (ms: number) => void }).advance?.(Math.min(hours, 72) * HOUR);
        app.policy.markRgFeedSynced(T); // demo: latido del feed JR tras adelantar el reloj
        return send(res, 200, { processed: app.runtime.runDue(), now: app.clock.now().toISOString() });
      }
      if (route === 'POST /runtime/pause') {
        if (!actor.roles.some((x) => ['tenant_admin', 'rg_officer'].includes(x))) return send(res, 403, { error: 'forbidden' });
        const b = await body(req);
        app.runtime.setGlobalPause(T, Boolean(b.paused), actor.id, String(b.reason ?? 'manual'));
        return send(res, 200, { global_pause: app.runtime.isGloballyPaused(T) });
      }
      if (route === 'GET /rewards') return send(res, 200, { catalog: app.rewards.catalog(T).map((i) => ({ ...i, budget: app.rewards.budget(T, i.id) })), grants: app.rewards.grants(T).slice(-50) });
      if (route === 'POST /rewards/reconcile') return send(res, 200, app.rewards.reconcile(T));
      if (route === 'GET /analytics/campaigns') {
        return send(res, 200, app.registry.live(T).filter((j) => j.purpose === 'marketing').map((j) => {
          const inst = app.runtime.instances(T, { journey_id: j.id });
          const conv = (arm: string) => inst.filter((i) => i.arm === arm && (app.ingestor.get(T, i.player_id)?.stats.deposit_count ?? 0) > 0).length;
          const cost = app.rewards.grants(T).filter((g) => g.status === 'confirmed' && g.idempotency_key.includes(`:${j.id}:`)).reduce((s, g) => s + g.value.amount_minor, 0);
          return report({ campaign: j.id, window: { from: j.updated_at, to: app.clock.now().toISOString() }, primary_metric: 'has_deposit', treatment: { n: inst.filter((i) => i.arm === 'treatment').length, conversions: conv('treatment') }, control: { n: inst.filter((i) => i.arm === 'control').length, conversions: conv('control') }, cost_minor: cost, currency: 'COP' });
        }));
      }
      if (route === 'GET /audit') {
        if (!actor.roles.some((x) => ['auditor', 'tenant_admin', 'approver'].includes(x))) return send(res, 403, { error: 'forbidden' });
        return send(res, 200, { chain_valid: app.audit.verifyChain(), entries: app.audit.list(T).slice(-200) });
      }
      const cs = (): CopilotSession => ({ tenant_id: T, operator_id: actor.id, roles: actor.roles.filter((x) => ['crm_analyst', 'approver', 'support', 'auditor'].includes(x)) as CopilotSession['roles'] });
      if (route === 'GET /copilot/tools') return send(res, 200, app.copilot.definitionsFor(cs()));
      if ((r = m(/^POST \/copilot\/tools\/(\w+)$/))) return send(res, 200, app.copilot.call(cs(), r[1], await body(req)));
      if (route === 'POST /copilot/ask') {
        const b = await body(req);
        return send(res, 200, await askCopilot(app.copilot, cs(), String(b.question ?? '')));
      }
      return send(res, 404, { error: 'route_not_found', route });
    } catch (e) {
      const err = e as DomainError;
      const status = err.code === 'forbidden' || err.code === 'tenant_mismatch' || err.code === 'segregation_of_duties' ? 403 : err.code ? 422 : 500;
      return send(res, status, { error: err.code ?? 'internal_error', message: err.message });
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp(new OffsetClock());
  const demoTenants = ['tenant-rumbawin', 'tenant-demo-b'];
  for (const t of demoTenants) { seedTenant(app, t); seedDemoPlayers(app, t, t === 'tenant-rumbawin' ? 40 : 12); }
  // demo: simula el latido del feed de juego responsable (en producción lo publica la fuente)
  const heartbeat = () => demoTenants.forEach((t) => app.policy.markRgFeedSynced(t));
  heartbeat();
  setInterval(heartbeat, 60_000).unref();
  const port = Number(process.env.PORT ?? 3000);
  createServer(createHandler(app)).listen(port, () => console.log(`SS1 CRM & Gamificación → http://localhost:${port}`));
}

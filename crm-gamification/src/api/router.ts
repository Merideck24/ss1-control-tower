import { ev, type App } from '../app.ts';
import type { CopilotSession, CopilotTools } from '../copilot/tools.ts';
import { report } from '../experiments/experiments.ts';
import { journeyAsList, validateJourney } from '../journeys/model.ts';
import { autoLayout, reviewJourney } from '../journeys/builder.ts';
import { SplitTracker } from '../experiments/bandit.ts';
import { CHANNELS, EVENT_TYPES, NON_PLAYER_EVENTS } from '../domain/events.ts';
import type { Actor, Role } from '../journeys/registry.ts';
import { simulateJourney } from '../journeys/runtime.ts';
import { profileView } from '../profile/projection.ts';
import { runSegment, validateRules, SEGMENT_FIELDS } from '../segments/segmentEngine.ts';
import { DomainError, HOUR, toCsv } from '../shared/util.ts';
import { journeyImpact } from '../analytics/journeyImpact.ts';
import { sourceQuality } from '../analytics/affiliates.ts';
import { CSV_TYPES, csvToEvents } from '../ingestion/csvImport.ts';
import { WEBHOOK_EVENTS } from '../integration/outbound.ts';
import { computeRfm, distribution, lifecycleOf, LIFECYCLE_LABELS, RFM_LABELS } from '../analytics/rfm.ts';
import { ABUSE_RULES } from '../analytics/bonusAbuse.ts';
import { RISK_RULES } from '../risk/riskMonitor.ts';
import { PLACEMENTS, type Placement } from '../onsite/onsite.ts';
import { baseWriter, type WriterFn } from '../content/studio.ts';
import { moderate, MODERATION_RULES } from '../content/moderation.ts';
import { Ss1Client } from '../integration/ss1Client.ts';
import { mapTriggerCatalog, runConnector, SS1_ENDPOINTS } from '../integration/ss1Connectors.ts';
import { deriveBrandTokens, parseThemeConfig } from '../integration/theme.ts';

const THEME_CACHE = new Map<string, { until: number; body: unknown }>();

export type ApiRequest = { method: string; path: string; query: URLSearchParams; headers: Record<string, string | undefined>; body: Record<string, unknown> };
export type ApiResponse = { status: number; body: unknown; contentType?: string; filename?: string };
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
  'gamification.read': ['crm_analyst', 'approver', 'tenant_admin', 'auditor', 'support'],
  'player.preferences': ['support', 'tenant_admin'],
  'integration.read': ['crm_analyst', 'approver', 'tenant_admin'],
  'ingest.csv': ['tenant_admin'],
  'policy.read': ['tenant_admin', 'approver', 'rg_officer', 'auditor', 'crm_analyst'],
  'policy.propose': ['tenant_admin', 'rg_officer'],
  'content.read': ['crm_analyst', 'approver', 'tenant_admin', 'auditor'],
  'onsite.read': ['crm_analyst', 'approver', 'tenant_admin', 'auditor'],
  'rg.monitor': ['rg_officer', 'tenant_admin', 'auditor'],
  'rg.act': ['rg_officer'],
  'abuse.read': ['crm_analyst', 'approver', 'tenant_admin', 'auditor', 'rg_officer'],
  'abuse.review': ['approver', 'tenant_admin'],
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

const moneyFmt = (minor: number) => (minor / 100).toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

export function controlTower(app: App, tenant: string, brand?: string) {
  const inBrand = (player: string) => !brand || app.ingestor.get(tenant, player)?.brand_id === brand;
  const instances = app.runtime.instances(tenant).filter((i) => inBrand(i.player_id));
  const receipts = app.channels.receipts(tenant).filter((r) => inBrand(r.player_id));
  const lat = app.ingestor.latency(tenant);
  const count = <T,>(xs: T[], f: (x: T) => string) => xs.reduce<Record<string, number>>((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
  return {
    as_of: app.clock.now().toISOString(),
    global_pause: app.runtime.isGloballyPaused(tenant),
    brand: brand ?? null,
    latency: { ...lat, slo_p95_ms: 250, within_slo: lat.p95_ms === null ? null : lat.p95_ms <= 250 },
    journeys: app.registry.list(tenant).filter((j) => !brand || j.brand_id === brand).map((j) => ({ id: j.id, name: j.name, version: j.version, status: j.status, purpose: j.purpose, control_group_pct: j.control_group_pct ?? 0, instances: count(instances.filter((i) => i.journey_id === j.id && i.version === j.version), (i) => i.status) })),
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

export async function route(app: App, req: ApiRequest, opts: { ask?: AskFn; write?: WriterFn; actor?: Actor; ss1?: Ss1Context } = {}): Promise<ApiResponse> {
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
    const brand = req.query.get('brand') || undefined;
    if (r0 === 'GET /control-tower') return ok(controlTower(app, T, brand));
    if (r0 === 'GET /webhooks') {
      if (!can(actor, 'integration.read')) return forbid('integration.read');
      const ds = app.webhooks.deliveries(T);
      return ok({ events: WEBHOOK_EVENTS, subscriptions: app.webhooks.list(T).map((s) => { const mine = ds.filter((d) => d.subscription_id === s.id); return { ...s, deliveries: { delivered: mine.filter((d) => d.status === 'delivered').length, pending: mine.filter((d) => d.status === 'pending').length, failed: mine.filter((d) => d.status === 'failed').length, dead: mine.filter((d) => d.status === 'dead').length } }; }),
        recent: ds.slice(0, 30).map(({ body: _b, ...d }) => d), bus_topics: app.bus.topics(),
        note: 'Firma: cabecera X-SS1-CRM-Signature «t=<seg>,v1=<HMAC-SHA256(secreto, "<t>.<cuerpo>")>»; X-SS1-CRM-Delivery es el id para deduplicar. Reintentos a 1 min, 5 min, 30 min, 2 h y 6 h; 4xx (salvo 408/429) no se reintenta; 20 fallos seguidos desactivan la suscripción.' });
    }
    if (r0 === 'POST /webhooks') {
      if (!can(actor, 'integration.sync')) return forbid('integration.sync');
      return ok(app.webhooks.create(actor, req.body as never), 201);
    }
    if ((r = m(/^POST \/webhooks\/([\w-]+)\/(pause|resume|rotate)$/))) {
      if (!can(actor, 'integration.sync')) return forbid('integration.sync');
      return ok(r[2] === 'rotate' ? app.webhooks.rotate(actor, r[1]) : app.webhooks.setStatus(actor, r[1], r[2] === 'pause' ? 'paused' : 'active'));
    }
    if ((r = m(/^POST \/webhooks\/deliveries\/([\w-]+)\/retry$/))) {
      if (!can(actor, 'integration.sync')) return forbid('integration.sync');
      return ok(app.webhooks.retry(actor, r[1]));
    }
    if (r0 === 'POST /webhooks/dispatch') {
      if (!can(actor, 'integration.sync')) return forbid('integration.sync');
      return ok(await app.webhooks.dispatch());
    }
    if (r0 === 'GET /brands') {
      const counts = new Map<string, number>();
      for (const p of app.ingestor.all(T)) counts.set(p.brand_id, (counts.get(p.brand_id) ?? 0) + 1);
      for (const p of app.policy.listPolicies(T)) if (!counts.has(p.brand_id)) counts.set(p.brand_id, 0);
      return ok([...counts].map(([brand_id, players]) => ({ brand_id, players })).sort((a, b) => b.players - a.players));
    }
    if (r0 === 'POST /ingest/csv') {
      if (!can(actor, 'ingest.csv')) return forbid('ingest.csv');
      const type = String(req.body.event_type ?? '') as never;
      const conv = csvToEvents(type, String(req.body.csv ?? ''), { tenant_id: T, brand_id: String(req.body.brand_id ?? 'rumbawin'), source: `csv.${actor.id}` });
      const dry = req.body.dry_run !== false;
      // histórico por defecto: actualiza perfiles y métricas sin disparar recorridos ni mensajes
      const live = req.body.mode === 'tiempo_real';
      const tally = { applied: 0, duplicate: 0, rejected: 0 };
      if (!dry && !conv.errors.length) for (const e of conv.events) { const r = app.ingestor.ingest(e, { replay: !live }); tally[r.status === 'applied' ? 'applied' : r.status === 'duplicate' ? 'duplicate' : 'rejected']++; }
      if (!dry && !conv.errors.length) app.audit.record(T, actor.id, 'ingest.csv', String(type), { rows: conv.rows, ...tally, mode: live ? 'tiempo_real' : 'historico' });
      return ok({ event_type: type, rows: conv.rows, valid: conv.events.length, errors: conv.errors.slice(0, 50), error_count: conv.errors.length, dry_run: dry, mode: live ? 'tiempo_real' : 'historico', ...(dry ? {} : tally),
        note: conv.errors.length ? 'No se cargó nada: corrige las filas con error y vuelve a subir el archivo (todo o nada).' : dry ? 'Validación sin cambios. Envía con dry_run=false para cargar.' : 'Carga aplicada. Volver a subir el mismo archivo no duplica eventos.', types: Object.keys(CSV_TYPES) });
    }
    if (r0 === 'POST /events') {
      if (req.body.tenant_id !== T) return { status: 403, body: { error: 'tenant_mismatch' } };
      const out = app.ingestor.ingest(req.body);
      return ok({ status: out.status, reason: out.reason }, out.status === 'rejected' ? 422 : 202);
    }
    if (r0 === 'GET /players') {
      if (!can(actor, 'players.read')) return forbid('players.read');
      const q = req.query.get('q') ?? '';
      const recent = req.query.get('sort') === 'recent';
      const all = app.ingestor.all(T).filter((p) => p.player_id.includes(q) && (!brand || p.brand_id === brand));
      if (recent) all.sort((a, b) => (b.timeline.at(-1)?.occurred_at ?? '').localeCompare(a.timeline.at(-1)?.occurred_at ?? ''));
      return ok(all.slice(0, 100).map((p) => ({ player_id: p.player_id, kyc: p.kyc?.value, rg: p.rg?.value, deposits_minor: p.stats.deposits_minor, currency: p.stats.currency, level: app.loyalty.program(T, p.brand_id) ? app.loyalty.progress(T, p.brand_id, p.player_id).level : null })));
    }
    if ((r = m(/^GET \/players\/([\w-]+)$/))) {
      if (!can(actor, 'players.read')) return forbid('players.read');
      const p = app.ingestor.get(T, r[1]);
      if (!p) return { status: 404, body: { error: 'not_found', message: `No existe el jugador ${r[1]} en ${T}` } };
      const decisions = Object.fromEntries(CHANNELS.map((c) => [c, app.policy.decide({ profile: p, purpose: 'marketing', channel: c })]));
      return ok({
        as_of: app.clock.now().toISOString(),
        profile: profileView(p),
        loyalty: app.loyalty.program(T, p.brand_id) ? { ...app.loyalty.progress(T, p.brand_id, p.player_id), movements: app.loyalty.movements(T, p.player_id).slice(-20) } : null,
        eligibility_explanation: { marketing: decisions, incentive: app.policy.decide({ profile: p, purpose: 'marketing', incentive: true }) },
        receipts: app.channels.receipts(T, p.player_id),
        journeys: app.runtime.instances(T, { player_id: p.player_id }),
        grants: app.rewards.grants(T).filter((g) => g.player_id === p.player_id),
        gamification: { ...app.gamification.playerView(T, p.player_id),
          tournaments: app.games.tournaments(T).filter((t) => t.status === 'active' || t.status === 'finished').map((t) => { const st = app.games.standings(T, t.id); const me = st.find((x) => x.player_id === p.player_id); return { id: t.id, name: t.name, status: t.status, ends_at: t.ends_at, rank: me?.rank ?? null, score: me?.score ?? 0, participants: st.length }; }),
          minigames: app.games.games(T).map((g) => ({ id: g.id, name: g.name, spins_left: app.games.spinsLeft(T, g.id, p.player_id) })),
          coins: app.store.balance(T, p.player_id), coin_ledger: app.store.ledger(T, p.player_id).slice(-8), redemptions: app.store.redemptions(T, p.player_id),
          store: app.store.items(T).filter((i) => i.active).map((i) => ({ id: i.id, name: i.name, price_coins: i.price_coins, stock: i.stock })),
          predictions: app.store.predictions(T).map((x) => ({ id: x.id, name: x.name, question: x.question, options: x.options, closes_at: x.closes_at, status: x.status, resolved_option: x.resolved_option ?? null, reward: x.reward, my_pick: app.store.picks(T, x.id).get(p.player_id)?.option ?? null })) },
        segmentation: (() => {
          const now = app.clock.now();
          const life = lifecycleOf(p, now);
          const s = computeRfm(app.ingestor.all(T), now).get(p.player_id);
          const pid = app.personas(T).assignment.get(p.player_id);
          return { lifecycle: { key: life, label: LIFECYCLE_LABELS[life] }, rfm: s ? { ...s, label: RFM_LABELS[s.segment] } : null, predictions: app.models(T).predictions.get(p.player_id) ?? null,
            persona: pid ? app.personas(T).personas.find((x) => x.id === pid) ?? null : null, nba: app.nba(T, p.player_id) ?? null };
        })(),
        rg_risk: can(actor, 'rg.monitor') ? { ...app.risk.assess(T, p.player_id, p.timezone?.value), cases: app.risk.cases(T).filter((c) => c.player_id === p.player_id) } : undefined,
        bonus_abuse: can(actor, 'abuse.read') ? app.abuse(T, p.player_id) ?? null : undefined,
      });
    }
    if ((r = m(/^GET \/players\/([\w-]+)\/inbox$/))) {
      if (!can(actor, 'players.read')) return forbid('players.read');
      return ok({ ...app.adapters.inapp.list(T, r[1], { include_archived: req.query.get('archived') === '1' }), as_of: app.clock.now().toISOString() });
    }
    if ((r = m(/^POST \/players\/([\w-]+)\/inbox\/read-all$/))) {
      if (!can(actor, 'player.preferences')) return forbid('player.preferences');
      return ok(app.adapters.inapp.markAllRead(T, r[1]));
    }
    if ((r = m(/^POST \/players\/([\w-]+)\/inbox\/([^/]+)\/(read|archive)$/))) {
      if (!can(actor, 'player.preferences')) return forbid('player.preferences');
      return ok(r[3] === 'read' ? app.adapters.inapp.markRead(T, r[1], r[2]) : app.adapters.inapp.archive(T, r[1], r[2]));
    }
    if (r0 === 'GET /channels/status') {
      if (!can(actor, 'analytics.read')) return forbid('analytics.read');
      const rs = app.channels.receipts(T);
      return ok({ channels: CHANNELS.map((c) => { const x = rs.filter((r) => r.channel === c); const reasons = new Map<string, number>(); for (const r of x) if (r.status !== 'accepted' && r.reason) { const k = r.reason.split(':')[0]; reasons.set(k, (reasons.get(k) ?? 0) + 1); }
        return { channel: c, accepted: x.filter((r) => r.status === 'accepted').length, failed: x.filter((r) => r.status === 'failed').length, suppressed: x.filter((r) => r.status === 'suppressed').length, deferred: x.filter((r) => r.status === 'deferred').length, top_reasons: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, n]) => ({ reason, n })) }; }),
        inbox: app.adapters.inapp.stats(T),
        transport: app.demoProviders ? 'simulado (demo)' : 'sin configurar', note: 'SMS, WhatsApp y Telegram usan transporte simulado y contactos sintéticos en la demo. En producción, el gateway de SS1 resuelve teléfono y chat al enviar e inyecta las credenciales; el CRM no los almacena.' });
    }
    if (r0 === 'GET /segments/fields') return ok(SEGMENT_FIELDS);
    if (r0 === 'GET /models') {
      if (!can(actor, 'analytics.read')) return forbid('analytics.read');
      const m = app.models(T);
      const preds = [...m.predictions.values()];
      return ok({ as_of: m.as_of, models: m.models, value: m.value, vip_threshold_minor: m.vip_threshold_minor, notes: m.notes,
        summary: { scored: preds.length, high_churn: preds.filter((p) => (p.churn?.p ?? 0) >= 0.6).length, vip_early: preds.filter((p) => p.vip_early).length, not_promo_eligible: preds.filter((p) => !p.promo_eligible).length } });
    }
    if (r0 === 'GET /gamification/missions') {
      if (!can(actor, 'gamification.read')) return forbid('gamification.read');
      return ok({ missions: app.gamification.stats(T), badges: app.gamification.playerView(T, '__catalog__').badge_catalog });
    }
    if (r0 === 'GET /gamification/tournaments') {
      if (!can(actor, 'gamification.read')) return forbid('gamification.read');
      return ok(app.games.tournaments(T).map((t) => ({ ...t, standings: app.games.standings(T, t.id).slice(0, 10), participants: app.games.standings(T, t.id).length })));
    }
    if (r0 === 'POST /gamification/tournaments') {
      if (!can(actor, 'journeys.draft')) return forbid('journeys.draft');
      return ok(app.games.saveTournament(actor, req.body as never), 201);
    }
    if ((r = m(/^POST \/gamification\/tournaments\/([\w-]+)\/(activate|finalize)$/))) {
      if (r[2] === 'finalize') { if (!can(actor, 'journeys.approve') && !can(actor, 'runtime.global_pause')) return forbid('journeys.approve'); return ok(app.games.finalizeTournament(actor, r[1])); }
      if (!can(actor, 'journeys.submit') && !can(actor, 'journeys.approve')) return forbid('journeys.submit');
      return ok(app.games.activateTournament({ ...actor, canApprove: can(actor, 'journeys.approve') }, r[1]));
    }
    if (r0 === 'GET /gamification/store') {
      if (!can(actor, 'gamification.read')) return forbid('gamification.read');
      const reds = app.store.redemptions(T);
      return ok({ items: app.store.items(T).map((i) => ({ ...i, redeemed: reds.filter((r) => r.item_id === i.id && r.status === 'fulfilled').length, refunded: reds.filter((r) => r.item_id === i.id && r.status === 'refunded').length })), coin_rate: `1 moneda por cada ${moneyFmt(app.store.coinRateMinor)} apostados`,
        predictions: app.store.predictions(T).map((p) => { const picks = [...app.store.picks(T, p.id).values()]; return { ...p, picks: picks.length, distribution: Object.fromEntries(p.options.map((o) => [o, picks.filter((x) => x.option === o).length])) }; }) });
    }
    if (r0 === 'POST /gamification/store/items') {
      if (!can(actor, 'alerts.configure')) return forbid('alerts.configure');
      return ok(app.store.saveItem(actor, req.body as never), 201);
    }
    if (r0 === 'POST /gamification/store/redeem') {
      if (!can(actor, 'player.preferences')) return forbid('player.preferences'); // backoffice: soporte/admin en nombre del jugador
      return ok(await app.store.redeem(T, String(req.body.player_id), String(req.body.item_id), String(req.body.request_id ?? '')));
    }
    if ((r = m(/^POST \/players\/([\w-]+)\/coins$/))) {
      if (!can(actor, 'alerts.configure')) return forbid('alerts.configure');
      return ok(app.store.adjust(actor, r[1], Number(req.body.amount), String(req.body.reason ?? ''), String(req.body.request_id ?? '')));
    }
    if (r0 === 'POST /gamification/predictions') {
      if (!can(actor, 'journeys.draft')) return forbid('journeys.draft');
      return ok(app.store.savePrediction(actor, req.body as never), 201);
    }
    if ((r = m(/^POST \/gamification\/predictions\/([\w-]+)\/(pick|resolve)$/))) {
      if (r[2] === 'resolve') { if (!can(actor, 'journeys.approve')) return forbid('journeys.approve'); return ok(app.store.resolve(actor, r[1], String(req.body.option))); }
      if (!can(actor, 'player.preferences')) return forbid('player.preferences');
      return ok(app.store.pick(T, r[1], String(req.body.player_id), String(req.body.option)));
    }
    if (r0 === 'GET /gamification/minigames') {
      if (!can(actor, 'gamification.read')) return forbid('gamification.read');
      return ok(app.games.games(T).map((g) => {
        const spins = app.games.spinsOf(T, g.id);
        const observed = Object.fromEntries(g.prizes.map((p) => [p.id, spins.filter((s) => s.outcome === p.id).length]));
        return { ...g, expected: app.games.expected(T, g), seeds: app.games.seeds(T, g.id), spins: spins.length, observed };
      }));
    }
    if ((r = m(/^POST \/gamification\/minigames\/([\w-]+)\/(spin|rotate-seed)$/))) {
      if (r[2] === 'rotate-seed') { if (!can(actor, 'alerts.configure')) return forbid('alerts.configure'); return ok(app.games.rotateSeed(actor, r[1])); }
      if (!can(actor, 'player.preferences')) return forbid('player.preferences'); // en el backoffice: soporte/admin en nombre del jugador
      return ok(app.games.spin(T, r[1], String(req.body.player_id), String(req.body.request_id ?? '')));
    }
    if ((r = m(/^GET \/gamification\/minigames\/([\w-]+)\/verify$/))) {
      const g = app.games.game(T, r[1]); if (!g) return { status: 404, body: { error: 'not_found' } };
      const seed = req.query.get('seed') ?? '';
      const { outcomeFor } = await import('../gamification/games.ts');
      const { sha256 } = await import('../shared/util.ts');
      return ok({ commit: sha256(seed), outcome: outcomeFor(seed, req.query.get('player') ?? '', Number(req.query.get('nonce')), g.prizes).id });
    }
    if (r0 === 'POST /gamification/missions') {
      if (!can(actor, 'journeys.draft')) return forbid('journeys.draft');
      return ok(app.gamification.save(actor, req.body as never), 201);
    }
    if ((r = m(/^POST \/gamification\/missions\/([\w-]+)\/(activate|pause)$/))) {
      const perm = r[2] === 'pause' ? 'journeys.pause' : 'journeys.submit';
      if (!can(actor, perm) && !can(actor, 'journeys.approve')) return forbid(perm);
      return ok(r[2] === 'pause' ? app.gamification.pause(actor, r[1]) : app.gamification.activate({ ...actor, canApprove: can(actor, 'journeys.approve') }, r[1]));
    }
    if ((r = m(/^POST \/players\/([\w-]+)\/gamification-preference$/))) {
      if (!can(actor, 'player.preferences')) return forbid('player.preferences');
      if (!app.ingestor.get(T, r[1])) return { status: 404, body: { error: 'not_found' } };
      const optOut = req.body.opt_out === true;
      app.loyalty.setOptOut(T, r[1], optOut);
      app.audit.record(T, actor.id, 'player.gamification_preference', r[1], { opt_out: optOut });
      return ok({ player_id: r[1], opt_out: optOut });
    }
    if (r0 === 'GET /personas') {
      if (!can(actor, 'segments.preview')) return forbid('segments.preview');
      const pm = app.personas(T);
      return ok({ k: pm.k, personas: pm.personas, method: 'k-means determinista (k-means++, semilla fija) sobre variables estandarizadas: peso del casino, apuesta media, días activos y depósitos en 30 días, recencia, uso de bonos y juego nocturno. Nombre = rasgos que más distinguen al grupo.' });
    }
    if (r0 === 'GET /nba/summary') {
      if (!can(actor, 'analytics.read')) return forbid('analytics.read');
      const rows = app.ingestor.all(T).map((p) => app.nba(T, p.player_id)!).filter(Boolean);
      const by = new Map<string, { label: string; players: number; expected_value_minor: number }>();
      let blocked = 0;
      for (const r of rows) {
        const g = by.get(r.chosen.action) ?? { label: r.chosen.label, players: 0, expected_value_minor: 0 };
        g.players++; g.expected_value_minor += r.chosen.expected_value_minor; by.set(r.chosen.action, g);
        if (r.candidates.some((c) => !c.allowed)) blocked++;
      }
      return ok({ players: rows.length, actions: [...by].map(([action, v]) => ({ action, ...v })).sort((a, b) => b.players - a.players), with_blocked_candidates: blocked, note: 'Recomendaciones; se ejecutan solo mediante recorridos aprobados. Efectos supuestos a calibrar con grupos de control.' });
    }
    if (r0 === 'GET /policies') {
      if (!can(actor, 'policy.read')) return forbid('policy.read');
      const props = app.governance.proposals(T);
      return ok({ policies: app.policy.listPolicies(T).map((p) => ({ ...p, history: app.governance.history(T, p.brand_id, p.market), pending: props.filter((x) => x.status === 'pending' && x.market === p.market && x.brand_id === p.brand_id).length })),
        proposals: props.slice(0, 30), channels: CHANNELS,
        note: 'Cada cambio crea una versión nueva que aprueba otra persona; recién entonces se aplica. Lo que relaja una protección exige justificación. Las decisiones registran la versión de política que se usó.' });
    }
    if (r0 === 'POST /policies/proposals') {
      if (!can(actor, 'policy.propose')) return forbid('policy.propose');
      return ok(app.governance.propose(actor, req.body.policy as never, String(req.body.justification ?? '')), 201);
    }
    if ((r = m(/^POST \/policies\/proposals\/([\w.-]+)\/(approve|reject)$/))) {
      if (!can(actor, 'journeys.approve')) return forbid('journeys.approve');
      return ok(app.governance.decide(actor, r[1], r[2] === 'approve', String(req.body.reason ?? '')));
    }
    if (r0 === 'GET /content/drafts') {
      if (!can(actor, 'content.read')) return forbid('content.read');
      return ok({ drafts: app.content.drafts(T), ai_enabled: Boolean(opts.write), moderation_version: MODERATION_RULES.version,
        note: opts.write ? 'La IA escribe borradores; la moderación y la aprobación de otra persona son obligatorias antes de que exista la plantilla.' : 'Sin credenciales de Anthropic: se genera un texto base sin IA para editar. La moderación y la aprobación son las mismas.' });
    }
    if (r0 === 'POST /content/drafts') {
      if (!can(actor, 'journeys.draft')) return forbid('journeys.draft');
      return ok(await app.content.generate(actor, req.body as never, opts.write ?? baseWriter), 201);
    }
    if (r0 === 'POST /content/moderate') {
      if (!can(actor, 'journeys.draft')) return forbid('journeys.draft');
      const b = req.body as { texts?: Record<string, { subject?: string; body: string; sms?: string }>; purpose?: 'marketing' | 'service'; vars?: string[] };
      return ok({ issues: moderate(b.texts ?? {}, { purpose: b.purpose === 'service' ? 'service' : 'marketing', allowedVars: b.vars ?? [] }), version: MODERATION_RULES.version });
    }
    if ((r = m(/^POST \/content\/drafts\/([\w-]+)\/(edit|submit|approve|reject)$/))) {
      const perm = r[2] === 'edit' ? 'journeys.draft' : r[2] === 'submit' ? 'journeys.submit' : 'journeys.approve';
      if (!can(actor, perm)) return forbid(perm);
      if (r[2] === 'edit') return ok(app.content.edit(actor, r[1], (req.body.texts ?? {}) as never));
      if (r[2] === 'submit') return ok(app.content.submit(actor, r[1]));
      return ok(app.content.decide(actor, r[1], r[2] === 'approve', String(req.body.reason ?? '')));
    }
    if (r0 === 'GET /onsite/campaigns') {
      if (!can(actor, 'onsite.read')) return forbid('onsite.read');
      const st = app.onsite.stats(T);
      const now = app.clock.now().toISOString();
      return ok({ placements: PLACEMENTS, campaigns: app.onsite.campaigns(T).sort((a, b) => a.placement.localeCompare(b.placement) || b.priority - a.priority).map((c) => ({ ...c, live: c.status === 'active' && c.starts_at <= now && c.ends_at > now, stats: st.get(c.id) ?? { impressions: 0, unique_players: 0, clicks: 0, ctr: null, dismisses: 0 } })),
        note: 'El sitio pide qué mostrar en cada ubicación. Se aplican las mismas reglas que a los mensajes (consentimiento in-app, juego responsable, casos de riesgo abiertos), la prioridad, el tope diario por jugador y los descartes. Solo texto plano y enlaces https de la marca.' });
    }
    if (r0 === 'POST /onsite/campaigns') {
      if (!can(actor, 'journeys.draft')) return forbid('journeys.draft');
      return ok(app.onsite.save(actor, req.body as never), 201);
    }
    if ((r = m(/^POST \/onsite\/campaigns\/([\w-]+)\/(submit|approve|pause|resume)$/))) {
      const perm = r[2] === 'submit' ? 'journeys.submit' : r[2] === 'approve' ? 'journeys.approve' : 'journeys.pause';
      if (!can(actor, perm)) return forbid(perm);
      return ok(r[2] === 'submit' ? app.onsite.submit(actor, r[1]) : r[2] === 'approve' ? app.onsite.approve(actor, r[1]) : app.onsite.setPaused(actor, r[1], r[2] === 'pause'));
    }
    if ((r = m(/^GET \/onsite\/serve\/([\w-]+)$/))) {
      if (!can(actor, 'players.read')) return forbid('players.read');
      const p = app.ingestor.get(T, r[1]);
      if (!p) return { status: 404, body: { error: 'not_found', message: `No existe el jugador ${r[1]}` } };
      const placement = req.query.get('placement') as Placement;
      if (!PLACEMENTS.includes(placement)) return { status: 422, body: { error: 'invalid_placement', message: `Usa: ${PLACEMENTS.join(', ')}` } };
      return ok(app.onsite.serve(p, placement, { locale: req.query.get('locale') ?? p.locale?.value ?? 'es', request_id: req.query.get('request_id') ?? '' }));
    }
    if ((r = m(/^POST \/onsite\/events\/([\w-]+)$/))) {
      if (!can(actor, 'players.read')) return forbid('players.read');
      return ok(app.onsite.track(T, r[1], { campaign_id: String(req.body.campaign_id ?? ''), type: String(req.body.type ?? '') as never, request_id: String(req.body.request_id ?? '') }));
    }
    if (r0 === 'GET /risk/rg-monitor') {
      if (!can(actor, 'rg.monitor')) return forbid('rg.monitor');
      const cases = app.risk.cases(T).sort((a, b) => (a.status === 'closed' ? 1 : 0) - (b.status === 'closed' ? 1 : 0) || (b.level === 'high' ? 1 : 0) - (a.level === 'high' ? 1 : 0) || b.opened_at.localeCompare(a.opened_at));
      const open = cases.filter((c) => c.status !== 'closed');
      const bySignal = new Map<string, { label: string; cases: number }>();
      for (const c of open) for (const s of c.signals) { const g = bySignal.get(s.code) ?? { label: s.label, cases: 0 }; g.cases++; bySignal.set(s.code, g); }
      const inst = app.runtime.instances(T).filter((i) => i.journey_id === 'jrg_intervention');
      const receipts = inst.length ? app.channels.receipts(T).filter((r) => r.template.startsWith('rg_')) : [];
      return ok({ as_of: app.clock.now().toISOString(), rules: RISK_RULES,
        summary: { open: open.length, high: open.filter((c) => c.level === 'high').length, medium: open.filter((c) => c.level === 'medium').length, in_review: open.filter((c) => c.status === 'in_review').length, closed: cases.length - open.length, marketing_on_hold: open.filter((c) => c.level === 'high').length },
        signals: [...bySignal].map(([code, v]) => ({ code, ...v })).sort((a, b) => b.cases - a.cases),
        interventions: { started: inst.length, messages_accepted: receipts.filter((r) => r.status === 'accepted').length, messages_not_sent: receipts.filter((r) => r.status !== 'accepted').length },
        cases: cases.slice(0, 80),
        note: 'Señales calculadas al llegar cada evento. Un caso alto abierto pausa marketing e incentivos del jugador. Las restricciones oficiales (autoexclusión, límites) se deciden y registran en SS1.' });
    }
    if ((r = m(/^POST \/risk\/rg-cases\/([\w:.-]+)\/(take|close)$/))) {
      if (!can(actor, 'rg.act')) return forbid('rg.act');
      return ok(r[2] === 'take' ? app.risk.take(actor, r[1]) : app.risk.close(actor, r[1], String(req.body.outcome ?? ''), String(req.body.note ?? '')));
    }
    if (r0 === 'GET /risk/bonus-abuse') {
      if (!can(actor, 'abuse.read')) return forbid('abuse.read');
      const all = app.abuseAll(T);
      const flagged = all.filter((a) => a.tier !== 'ok' || a.review).sort((a, b) => b.score - a.score);
      const bySignal = new Map<string, { label: string; players: number }>();
      for (const a of all) for (const s of a.signals) { const g = bySignal.get(s.code) ?? { label: s.label, players: 0 }; g.players++; bySignal.set(s.code, g); }
      const held = app.rewards.grants(T).filter((g) => g.reason === 'abuse_review');
      const scaled = app.rewards.grants(T).filter((g) => g.multiplier !== undefined && g.status === 'confirmed');
      return ok({ as_of: app.clock.now().toISOString(), rules: ABUSE_RULES, players: all.length,
        tiers: { ok: all.filter((a) => a.tier === 'ok').length, watch: all.filter((a) => a.tier === 'watch').length, high: all.filter((a) => a.tier === 'high').length, valuable: all.filter((a) => a.valuable).length },
        signals: [...bySignal].map(([code, v]) => ({ code, ...v })).sort((a, b) => b.players - a.players),
        held_grants: held.length, scaled_grants: { down: scaled.filter((g) => g.multiplier! < 1).length, up: scaled.filter((g) => g.multiplier! > 1).length },
        flagged: flagged.slice(0, 50),
        note: 'Reglas explicables. «Alto» pausa incentivos (bonos, misiones y tienda) hasta que una persona revise; «Vigilar» reduce el bono a la mitad. Nunca bloquea depósitos, retiros ni el juego.' });
    }
    if ((r = m(/^POST \/risk\/bonus-abuse\/([\w-]+)\/review$/))) {
      if (!can(actor, 'abuse.review')) return forbid('abuse.review');
      if (!app.ingestor.get(T, r[1])) return { status: 404, body: { error: 'not_found', message: `No existe el jugador ${r[1]}` } };
      return ok({ review: app.abuseReviews.set(actor, r[1], String(req.body.status ?? ''), String(req.body.note ?? '')), assessment: app.abuse(T, r[1]) });
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
      const ruleText = JSON.stringify([b.rules, b.exclusions ?? null]);
      const extra = {
        ...(ruleText.includes('"pred.') ? { predict: (id: string) => app.models(T).predictions.get(id) } : {}),
        ...(ruleText.includes('"persona"') ? { persona: (id: string) => app.personas(T).assignment.get(id) } : {}),
        ...(ruleText.includes('"nba.action"') ? { nba: (id: string) => app.nba(T, id)?.chosen.action } : {}),
        ...(ruleText.includes('"abuse.') ? { abuse: (id: string) => app.abuse(T, id) } : {}),
      };
      const out = runSegment({ id: 'preview', tenant_id: T, name: 'preview', version: 0, rules: b.rules as never, exclusions: b.exclusions as never }, app.ingestor.all(T), app.clock.now(), extra);
      return ok({ size: out.members.length, excluded: out.excluded.length, universe: out.universe, snapshot_hash: out.snapshot_hash, sample: out.members.slice(0, 10) });
    }
    if (r0 === 'GET /journeys/builder' || r0 === 'POST /journeys/review') { if (!can(actor, 'journeys.draft')) return forbid('journeys.draft'); }
    if (r0 === 'GET /journeys/builder') {
      return ok({
        events: EVENT_TYPES.filter((e) => !NON_PLAYER_EVENTS.includes(e)),
        channels: CHANNELS,
        templates: app.channels.templates(T).map((t) => ({ key: t.key, purpose: t.purpose, category: t.category, subject: t.content.es?.subject ?? t.key })),
        rewards: app.rewards.catalog(T).map((i) => ({ id: i.id, reward_type: i.reward_type, value: i.value, approved: Boolean(i.approved_by) })),
        fields: SEGMENT_FIELDS,
        node_types: [
          { type: 'wait', label: 'Esperar' }, { type: 'condition', label: 'Condición' }, { type: 'message', label: 'Mensaje' },
          { type: 'grant_reward', label: 'Recompensa' }, { type: 'split', label: 'A/B/n' }, { type: 'exit', label: 'Salida' }],
      });
    }
    if (r0 === 'POST /journeys/review') {
      const j = req.body as never as Parameters<typeof reviewJourney>[0];
      if (!Array.isArray(j?.nodes)) return { status: 422, body: { error: 'invalid_journey', message: 'Falta la lista de pasos.' } };
      const issues = reviewJourney(j, { template: (k) => app.channels.template(T, k), reward: (id) => { const it = app.rewards.item(T, id); return it && { approved: Boolean(it.approved_by) }; } });
      return ok({ issues, valid: !issues.some((i) => i.severity === 'error'), layout: autoLayout(j), as_list: journeyAsList(j as never) });
    }
    if (r0 === 'GET /experiments/splits') {
      if (!can(actor, 'analytics.read')) return forbid('analytics.read');
      const now = app.clock.now().getTime();
      const out = [];
      for (const j of app.registry.live(T)) for (const n of j.nodes) {
        if (n.type !== 'split') continue;
        const key = SplitTracker.key(T, j.id, n.id);
        const st = app.splits.stats(key, n, now);
        const { phase } = app.splits.allocation(key, n, now);
        const lead = [...st].sort((a, b) => (b.p_best ?? 0) - (a.p_best ?? 0))[0];
        const warm = n.warmup_per_variant ?? 30;
        const decision = st.some((x) => x.decided < warm) ? `Calentamiento: faltan resultados cerrados (mínimo ${warm} por variante).`
          : (lead.p_best ?? 0) >= 0.95 ? `«${lead.label}» es la mejor con ${Math.round(100 * lead.p_best!)} % de probabilidad: puedes fijarla como ganadora.`
          : `Sin ganadora clara todavía (la mejor tiene ${Math.round(100 * (lead.p_best ?? 0))} % de probabilidad; se pide 95 %).`;
        out.push({ journey_id: j.id, journey: j.name, version: j.version, node: n.id, mode: n.mode, phase, metric: n.metric, min_explore_pct: n.min_explore_pct ?? 10, variants: st, decision });
      }
      return ok({ splits: out, note: 'Conversión = primer evento de la métrica dentro de la ventana tras la asignación; solo cuentan casos cerrados (convirtieron o venció la ventana). Probabilidad de ser la mejor por muestreo Beta-Binomial reproducible. Cada jugador ve siempre la misma variante.' });
    }
    if (r0 === 'GET /journeys/overlap') {
      const live = app.registry.live(T).filter((j) => j.purpose === 'marketing');
      const inst = app.runtime.instances(T);
      const stats = (id: string) => { const xs = inst.filter((i) => i.journey_id === id); return { entered: xs.filter((i) => i.status !== 'blocked_overlap').length, blocked: xs.filter((i) => i.status === 'blocked_overlap').length, preempted: xs.filter((i) => i.status === 'preempted').length }; };
      const risks: { journeys: string[]; trigger: string; message: string }[] = [];
      for (let a = 0; a < live.length; a++) for (let b = a + 1; b < live.length; b++) {
        const x = live[a], y = live[b];
        if (x.trigger.event_type !== y.trigger.event_type) continue;
        if (x.overlap && y.overlap && x.overlap.group === y.overlap.group) continue;
        risks.push({ journeys: [x.id, y.id], trigger: x.trigger.event_type, message: `«${x.name}» y «${y.name}» se disparan con ${x.trigger.event_type} sin compartir grupo: un jugador puede recibir ambos.` });
      }
      const groups = [...new Set(live.filter((j) => j.overlap).map((j) => j.overlap!.group))].map((g) => ({ group: g, journeys: live.filter((j) => j.overlap?.group === g).sort((a, b) => b.overlap!.priority - a.overlap!.priority).map((j) => ({ id: j.id, name: j.name, priority: j.overlap!.priority, cooldown_hours: j.overlap!.cooldown_hours ?? 0, ...stats(j.id) })) }));
      return ok({ groups, ungrouped: live.filter((j) => !j.overlap).map((j) => ({ id: j.id, name: j.name, trigger: j.trigger.event_type })), risks,
        frequency: (() => { const p = app.policy.policyFor({ tenant_id: T, brand_id: 'rumbawin', country: { value: 'CO' } } as never); return p ? { per_day: p.max_marketing_per_day, per_week: p.max_marketing_per_week ?? null, per_channel_day: p.max_marketing_per_day_by_channel ?? {} } : null; })(),
        note: 'Mismo grupo ⇒ un solo recorrido de marketing activo por jugador. Gana la prioridad mayor; en empate se queda el que ya está en curso. Los recorridos de servicio nunca se bloquean.' });
    }
    if (r0 === 'GET /journeys') return ok(app.registry.list(T).filter((j) => !brand || j.brand_id === brand).map((j) => ({ ...j, as_list: journeyAsList(j), validation: validateJourney(j) })));
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
        // conversión = depósito DESPUÉS de entrar y dentro de 14 días (no «alguna vez depositó»)
        const entered = (i: (typeof inst)[number]) => Date.parse(i.trace[0]?.at ?? '');
        const conv = (arm: string) => inst.filter((i) => i.arm === arm && [...(app.performance.fact(T, i.player_id)?.deposits.values() ?? [])].some((d) => d.at > entered(i) && d.at <= entered(i) + 14 * 24 * HOUR)).length;
        const cost = app.rewards.grants(T).filter((g) => g.status === 'confirmed' && g.idempotency_key.includes(`:${j.id}:`)).reduce((s, g) => s + g.value.amount_minor, 0);
        return report({ campaign: j.id, window: { from: j.updated_at, to: app.clock.now().toISOString() }, primary_metric: 'deposito_14d_tras_entrar', treatment: { n: inst.filter((i) => i.arm === 'treatment').length, conversions: conv('treatment') }, control: { n: inst.filter((i) => i.arm === 'control').length, conversions: conv('control') }, cost_minor: cost, currency: 'COP' });
      }));
    }
    if (r0 === 'GET /analytics/journey-impact') {
      if (!can(actor, 'analytics.read')) return forbid('analytics.read');
      const windowDays = Math.min(60, Math.max(3, Number(req.query.get('window') ?? 14)));
      const live = app.registry.live(T).filter((j) => j.purpose === 'marketing');
      const names = new Map(live.map((j) => [j.id, j.name]));
      const entries = app.runtime.instances(T).filter((i) => names.has(i.journey_id) && (i.arm === 'control' || i.status !== 'blocked_overlap')).map((i) => ({ journey_id: i.journey_id, player_id: i.player_id, arm: i.arm, at: Date.parse(i.trace[0]?.at ?? '') }));
      const grants = app.rewards.grants(T).filter((g) => g.status === 'confirmed');
      const costBy = (id: string) => grants.filter((g) => g.idempotency_key.includes(`:${id}:`)).reduce((s, g) => s + g.value.amount_minor, 0);
      const rows = journeyImpact(entries, (p) => app.performance.fact(T, p), { now: app.clock.now().getTime(), windowDays, taxRate: app.performance.financeDefinition(T).gaming_tax_rate, costByJourney: costBy });
      const rewardOf = (id: string) => live.find((j) => j.id === id)?.nodes.filter((n) => n.type === 'grant_reward').map((n) => (n as { reward_id: string }).reward_id) ?? [];
      const out = rows.map((r) => ({ ...r, name: names.get(r.journey_id) ?? r.journey_id, rewards: rewardOf(r.journey_id) }));
      const rewards = [...new Set(out.flatMap((r) => r.rewards))].map((rid) => { const js = out.filter((r) => r.rewards.includes(rid) && r.lift.incremental_ngr_minor !== null); const cost = js.reduce((s, r) => s + r.cost_minor, 0); const inc = js.reduce((s, r) => s + (r.lift.incremental_ngr_minor ?? 0), 0);
        return { reward_id: rid, journeys: js.map((r) => r.journey_id), cost_minor: cost, incremental_ngr_minor: js.length ? inc : null, ngr_per_cost: js.length && cost ? inc / cost : null, reliable: js.length > 0 && js.every((r) => r.lift.reliable) }; });
      if (req.query.get('format') === 'csv') return { status: 200, contentType: 'text/csv; charset=utf-8', filename: 'impacto-recorridos.csv', body: toCsv(['recorrido', 'nombre', 'ventana_dias', 'tratados', 'control', 'deposito_trat', 'deposito_ctrl', 'ngr_jugador_trat', 'ngr_jugador_ctrl', 'incremento_ngr_jugador', 'ic95_bajo', 'ic95_alto', 'incremento_total', 'costo', 'roi', 'confiable'],
        out.map((r) => [r.journey_id, r.name, r.window_days, r.treatment.n, r.control.n, r.treatment.deposit_rate.toFixed(4), r.control.deposit_rate.toFixed(4), r.treatment.ngr_per_player_minor / 100, r.control.ngr_per_player_minor / 100, r.lift.ngr_per_player_minor === null ? null : r.lift.ngr_per_player_minor / 100, r.lift.ngr_ci95_minor ? r.lift.ngr_ci95_minor[0] / 100 : null, r.lift.ngr_ci95_minor ? r.lift.ngr_ci95_minor[1] / 100 : null, r.lift.incremental_ngr_minor === null ? null : r.lift.incremental_ngr_minor / 100, r.cost_minor / 100, r.roi === null ? null : r.roi.toFixed(3), r.lift.reliable])) };
      return ok({ window_days: windowDays, journeys: out, rewards, note: `Resultados medidos después de entrar al recorrido y durante ${windowDays} días, contra el grupo de control. NGR = apuestas − premios − impuesto − bonos de la ventana. Solo cuentan entradas con la ventana cumplida.` });
    }
    if (r0 === 'GET /analytics/sources') {
      if (!can(actor, 'performance.read')) return forbid('performance.read');
      const days = Math.min(90, Math.max(7, Number(req.query.get('days') ?? 30)));
      const now = app.clock.now().getTime();
      const preds = app.models(T).predictions;
      const abuse = new Set(app.abuseAll(T).filter((a) => a.tier !== 'ok').map((a) => a.player_id));
      const rg = new Set(app.risk.cases(T).map((c) => c.player_id));
      const from = new Date(now - days * 24 * HOUR).toISOString().slice(0, 10);
      const q = sourceQuality({ facts: app.performance.playerFacts(T), now, days, predictedValue: (p) => preds.get(p)?.value_30d_minor, abuseFlag: (p) => abuse.has(p), rgCase: (p) => rg.has(p), spend: (c) => app.performance.spendSince(T, c, from), name: (c) => app.performance.campaignMeta(T, c) });
      if (req.query.get('format') === 'csv') return { status: 200, contentType: 'text/csv; charset=utf-8', filename: 'calidad-fuentes.csv', body: toCsv(['fuente', 'canal', 'registros', 'ftd', 'tasa_ftd', 'valor_previsto_30d', 'activos_d7', 'abuso', 'riesgo_jr', 'inversion', 'costo_por_ftd', 'valor_sobre_cpa', 'veredicto', 'motivos'],
        q.sources.map((s) => [s.name, s.channel, s.registrations, s.ftd, s.ftd_rate.toFixed(4), s.predicted_value_30d_minor === null ? null : s.predicted_value_30d_minor / 100, s.d7_active_rate === null ? null : s.d7_active_rate.toFixed(4), s.abuse_share.toFixed(4), s.rg_share.toFixed(4), s.spend_minor / 100, s.cost_per_ftd_minor === null ? null : s.cost_per_ftd_minor / 100, s.value_to_cpa === null ? null : s.value_to_cpa.toFixed(2), s.verdict, s.reasons.join('; ')])) };
      return ok({ days, ...q, note: 'Calidad temprana de los jugadores que trae cada fuente, comparada con el promedio del período. El valor previsto viene del modelo de valor a 30 días; «valor sobre CPA» < 1 indica que la fuente no se paga con lo previsto.' });
    }
    if (r0 === 'GET /performance') {
      if (!can(actor, 'performance.read')) return forbid('performance.read');
      const days = Math.min(365, Math.max(1, Number(req.query.get('days') ?? 30)));
      return ok(app.performanceReport(T, days, brand));
    }
    if (r0 === 'GET /performance/payback') {
      if (!can(actor, 'performance.read')) return forbid('performance.read');
      const weeks = Math.min(26, Math.max(1, Number(req.query.get('weeks') ?? 12)));
      return ok(app.performance.payback(T, { to: app.clock.now(), weeks, ...(brand ? { brand } : {}) }));
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

import { AuditLog } from './audit/audit.ts';
import { PerformanceStore } from './analytics/performance.ts';
import { KpiAlertCenter, evaluateKpiAlerts } from './analytics/kpiAlerts.ts';
import { trainModels, type ModelBundle } from './analytics/models.ts';
import { trainPersonas, type PersonaModel } from './analytics/personas.ts';
import { nextBestAction } from './analytics/nba.ts';
import { lifecycleOf } from './analytics/rfm.ts';
import { AbuseReviews, assessPlayer, type AbuseAssessment } from './analytics/bonusAbuse.ts';
import { GamificationService } from './gamification/missions.ts';
import { GamesService } from './gamification/games.ts';
import { StoreService } from './gamification/store.ts';
import { ChannelHub, MemoryAdapter } from './channels/channels.ts';
import { InboxAdapter } from './channels/inbox.ts';
import { SmsAdapter, TelegramAdapter, WhatsAppAdapter, demoTransport } from './channels/providers.ts';
import { stableBucket } from './shared/util.ts';
import { CopilotTools } from './copilot/tools.ts';
import type { EventEnvelope } from './domain/events.ts';
import { Ingestor } from './ingestion/ingestor.ts';
import type { JourneyDefinition } from './journeys/model.ts';
import { JourneyRegistry, type Actor } from './journeys/registry.ts';
import { JourneyRuntime } from './journeys/runtime.ts';
import { LoyaltyService } from './loyalty/loyalty.ts';
import { DEFAULT_POLICY, PolicyEngine } from './policy/policyEngine.ts';
import { MockBonusService, RewardService } from './rewards/rewards.ts';
import { SplitTracker } from './experiments/bandit.ts';
import { RiskMonitor } from './risk/riskMonitor.ts';
import { OnsiteService } from './onsite/onsite.ts';
import { ContentStudio } from './content/studio.ts';
import { DAY, systemClock, type Clock } from './shared/util.ts';

export type App = ReturnType<typeof createApp>;

/** Composición del módulo. En producción cada pieza se respalda en PostgreSQL/broker. */
/**
 * `demoProviders`: SMS/WhatsApp/Telegram responden con un transporte simulado y
 * contactos sintéticos (solo demo). Sin él, esos canales fallan como «no configurado».
 */
export function createApp(clock: Clock = systemClock, opts: { demoProviders?: boolean } = {}) {
  const audit = new AuditLog(clock);
  const ingestor = new Ingestor(clock);
  const policy = new PolicyEngine(clock);
  const channels = new ChannelHub(clock);
  const demo = opts.demoProviders === true;
  const adapters = { inapp: new InboxAdapter(clock), email: new MemoryAdapter('email'), webpush: new MemoryAdapter('webpush'),
    sms: new SmsAdapter({ account: 'AC-demo', sender: 'RUMBAWIN' }, demo ? demoTransport('sms') : undefined),
    whatsapp: new WhatsAppAdapter({ phone_number_id: 'demo' }, demo ? demoTransport('whatsapp') : undefined),
    telegram: new TelegramAdapter({ bot: 'TELEGRAM_BOT_TOKEN' }, demo ? demoTransport('telegram') : undefined) };
  if (demo) channels.contacts = (t, p, c) => { const u = stableBucket(`${t}:${p}:contact`); // contactos sintéticos
    return c === 'sms' ? (u < 0.7 ? `+5730${String(Math.floor(u * 1e8)).padStart(8, '0')}` : undefined) : c === 'whatsapp' ? (u < 0.45 ? `5730${String(Math.floor(u * 1e8)).padStart(8, '0')}` : undefined) : (u < 0.15 ? String(100000 + Math.floor(u * 1e6)) : undefined); };
  Object.values(adapters).forEach((a) => channels.register(a));
  const bonus = new MockBonusService(clock);
  const rewards = new RewardService(bonus, audit, clock);
  const loyalty = new LoyaltyService(clock);
  const registry = new JourneyRegistry(audit, clock);
  const risk = new RiskMonitor(audit, clock);
  policy.riskHold = (t, p) => risk.hasOpenHigh(t, p);
  const onsite = new OnsiteService({ audit, clock, policy });
  const splits = new SplitTracker();
  const runtime = new JourneyRuntime({
    splits, registry, policy, profiles: ingestor, audit, clock,
    effects: { send: (r) => channels.send(r), recordNonDelivery: (r) => channels.recordNonDelivery(r), grant: (r) => rewards.grant(r) },
  });
  const performance = new PerformanceStore();
  const alertCenter = new KpiAlertCenter();
  const copilot = new CopilotTools({ registry, policy, profiles: () => [...new Set(tenants)].flatMap((t) => ingestor.all(t)), audit, clock, performance: (t, days) => performanceReport(t, days) });
  const tenants: string[] = [];

  // bucle de eventos: proyección → fidelidad → recorridos
  // en reprocesamiento histórico solo se actualizan proyección y métricas: sin recorridos ni avisos
  const gamification = new GamificationService({ clock, audit, loyalty, rewards, policy, profile: (t, p) => ingestor.get(t, p) });
  const games = new GamesService({ clock, audit, loyalty, rewards, policy, profile: (t, p) => ingestor.get(t, p) });
  const store = new StoreService({ clock, audit, loyalty, rewards, policy, profile: (t, p) => ingestor.get(t, p) });
  ingestor.subscribe((e, prof, meta) => { performance.onEvent(e); splits.onEvent(e); if (meta.replay) return; loyalty.onEvent(e); gamification.onEvent(e, prof); games.onEvent(e, prof); store.onEvent(e, prof); risk.onEvent(e, prof); runtime.onEvent(e); });
  risk.emit = (e) => ingestor.ingest(e);
  bonus.onGranted = (e) => ingestor.ingest(e);
  loyalty.onThreshold = (e) => ingestor.ingest(e);

  /** Rendimiento enriquecido con CRM (alcance) y Loyalty (nivel). */
  function performanceReport(tenant: string, days: number) {
    return performance.report(tenant, { to: clock.now(), days }, {
      crmReached: (t, p) => channels.receipts(t, p).some((r) => r.status === 'accepted'),
      loyaltyLevelRank: (t, p) => {
        const prof = ingestor.get(t, p);
        const prog = prof && loyalty.program(t, prof.brand_id);
        return prog ? prog.levels.findIndex((l) => l.name === loyalty.progress(t, prof!.brand_id, p).level) : 0;
      },
    });
  }

  function kpiAlerts(tenant: string) {
    const budgets = rewards.catalog(tenant).map((it) => ({ reward_id: it.id, ...rewards.budget(tenant, it.id)! }));
    return alertCenter.withAcks(tenant, evaluateKpiAlerts({ store: performance, tenant, now: clock.now(), config: alertCenter.config(tenant), budgets }));
  }

  /** Modelos predictivos por tenant; se reentrenan cuando cambian los datos o cambia el día. */
  const modelCache = new Map<string, { key: string; bundle: ModelBundle }>();
  function models(tenant: string): ModelBundle {
    const key = `${ingestor.version}:${clock.now().toISOString().slice(0, 10)}`;
    const hit = modelCache.get(tenant);
    if (hit && hit.key === key) return hit.bundle;
    const bundle = trainModels(performance.playerFacts(tenant), clock.now(), { taxRate: performance.financeDefinition(tenant).gaming_tax_rate });
    modelCache.set(tenant, { key, bundle });
    return bundle;
  }

  const personaCache = new Map<string, { key: string; model: PersonaModel }>();
  function personas(tenant: string): PersonaModel {
    const key = `${ingestor.version}:${clock.now().toISOString().slice(0, 10)}`;
    const hit = personaCache.get(tenant);
    if (hit && hit.key === key) return hit.model;
    const model = trainPersonas(performance.playerFacts(tenant), clock.now());
    personaCache.set(tenant, { key, model });
    return model;
  }
  /** Mejor acción siguiente de un jugador (recomendación; no ejecuta nada). */
  function nba(tenant: string, playerId: string) {
    const p = ingestor.get(tenant, playerId);
    if (!p) return undefined;
    const prog = loyalty.program(tenant, p.brand_id) ? loyalty.progress(tenant, p.brand_id, playerId) : undefined;
    return nextBestAction(p, models(tenant).predictions.get(playerId), { lifecycle: lifecycleOf(p, clock.now()), loyaltyPct: prog?.next_level ? prog.percent_to_next : undefined, policy });
  }

  /** G9: evaluación de abuso de bonos por jugador (reglas explicables + revisión humana). */
  const abuseReviews = new AbuseReviews(audit, clock);
  function abuse(tenant: string, playerId: string): AbuseAssessment | undefined {
    const f = performance.fact(tenant, playerId);
    if (!f) return undefined;
    return assessPlayer(f, clock.now(), performance.linkedAccounts(tenant, playerId), (id) => (performance.fact(tenant, id)?.bonuses.length ?? 0) > 0, abuseReviews.get(tenant, playerId));
  }
  function abuseAll(tenant: string): AbuseAssessment[] {
    return performance.playerFacts(tenant).map((f) => abuse(tenant, f.player_id)!).filter(Boolean);
  }
  rewards.setGate((tenant, player) => {
    const a = abuse(tenant, player);
    return a && { multiplier: a.multiplier, reason: a.signals.map((s) => s.code).join(',') || (a.valuable ? 'valuable' : 'ok') };
  });

  const content = new ContentStudio({ audit, clock, channels });
  return { content, onsite, demoProviders: demo, risk, splits, abuse, abuseAll, abuseReviews, clock, audit, ingestor, policy, channels, adapters, bonus, rewards, loyalty, registry, runtime, copilot, tenants, performance, performanceReport, alertCenter, kpiAlerts, models, personas, nba, gamification, games, store };
}

/** Plantillas, política, catálogo, programa y los 5 primeros recorridos del piloto. */
export function seedTenant(app: App, tenant_id: string, brand_id = 'rumbawin') {
  app.tenants.push(tenant_id);
  app.policy.setPolicy(tenant_id, { ...DEFAULT_POLICY, brand_id });
  app.policy.markRgFeedSynced(tenant_id);
  // variantes por canal (F2): SMS corto y plantilla de WhatsApp aprobada (nombre registrado en Meta)
  const CH: Record<string, NonNullable<import('./channels/channels.ts').Template['channels']>> = {
    reward_granted: { sms: { es: 'RumbaWin: tienes {{reward_type}} por {{amount}} {{currency}} hasta {{expires_at}}. Juega con responsabilidad.' }, whatsapp: { name: 'reward_granted_v1', lang: 'es', params: ['reward_type', 'amount', 'currency', 'expires_at'] } },
    loyalty_halfway: { sms: { es: 'RumbaWin: vas al {{percent}}% del nivel {{level}}.' }, whatsapp: { name: 'loyalty_progress_v1', lang: 'es', params: ['percent', 'level'] } },
    rg_limits_reminder: { sms: { es: 'RumbaWin: puedes fijar limites o tomar una pausa desde tu perfil. Ayuda: soporte JR.' } },
  };
  const t = (key: string, category: 'transactional' | 'promotional', purpose: 'service' | 'marketing', es: [string, string], en: [string, string], pt: [string, string]) =>
    app.channels.addTemplate(tenant_id, { key, category, purpose, content: { es: { subject: es[0], body: es[1] }, en: { subject: en[0], body: en[1] }, pt: { subject: pt[0], body: pt[1] } }, ...(CH[key] ? { channels: CH[key] } : {}) });
  t('verify_reminder', 'transactional', 'service', ['Completa tu verificación', 'Tu cuenta está casi lista: completa la verificación desde tu perfil.'], ['Complete your verification', 'Your account is almost ready: finish verification from your profile.'], ['Conclua sua verificação', 'Sua conta está quase pronta: conclua a verificação no seu perfil.']);
  t('security_confirmation', 'transactional', 'service', ['Tu cuenta fue recuperada', 'Confirmamos el cambio de acceso. Si no fuiste tú, contacta a soporte.'], ['Your account was recovered', 'We confirm the access change. If this was not you, contact support.'], ['Sua conta foi recuperada', 'Confirmamos a alteração de acesso. Se não foi você, fale com o suporte.']);
  t('reward_granted', 'promotional', 'marketing', ['Tienes una recompensa', 'Recibiste {{reward_type}} por {{amount}} {{currency}}. Vigente hasta {{expires_at}}.'], ['You have a reward', 'You received {{reward_type}} worth {{amount}} {{currency}}. Valid until {{expires_at}}.'], ['Você tem uma recompensa', 'Você recebeu {{reward_type}} de {{amount}} {{currency}}. Válido até {{expires_at}}.']);
  t('rg_check_in', 'transactional', 'service', ['¿Cómo vas con tu juego?', 'Queremos que jugar siga siendo diversión. Revisa tu actividad y, si lo necesitas, fija límites de depósito o tiempo desde tu perfil.'], ['How is your play going?', 'We want play to stay fun. Review your activity and, if needed, set deposit or time limits from your profile.'], ['Como está seu jogo?', 'Queremos que jogar continue sendo diversão. Revise sua atividade e, se precisar, defina limites no seu perfil.']);
  t('rg_limits_reminder', 'transactional', 'service', ['Herramientas para jugar con control', 'Notamos mucha actividad en poco tiempo. Puedes fijar límites, tomar una pausa o hablar con nuestro equipo de juego responsable.'], ['Tools to stay in control', 'We noticed a lot of activity in a short time. You can set limits, take a break or talk to our responsible gaming team.'], ['Ferramentas para jogar com controle', 'Notamos muita atividade em pouco tempo. Você pode definir limites, fazer uma pausa ou falar com nossa equipe.']);
  t('loyalty_halfway', 'promotional', 'marketing', ['¡Vas a mitad de camino!', 'Llevas el {{percent}} % del camino al nivel {{level}}.'], ['Halfway there!', 'You are {{percent}}% of the way to {{level}}.'], ['Metade do caminho!', 'Você está a {{percent}}% do nível {{level}}.']);

  app.rewards.addItem({ id: 'welcome_fs_10', tenant_id, brand_id, reward_type: 'free_spins', value: { amount_minor: 1000_00, currency: 'COP' }, validity_days: 7, budget_minor: 50 * 1000_00, approved_by: 'compliance@ss1' });
  app.loyalty.setProgram({ tenant_id, brand_id, season: '2026-Q4', points_per_major_unit: 0.001, halfway_notice: true, levels: [{ name: 'Bronce', threshold: 0 }, { name: 'Plata', threshold: 1000 }, { name: 'Oro', threshold: 5000 }, { name: 'Platino', threshold: 20000 }] });

  const author: Actor = { id: 'analyst@ss1', tenant_id, roles: ['crm_analyst'] };
  const approver: Actor = { id: 'approver@ss1', tenant_id, roles: ['approver'] };
  const base = { brand_id, name: '' };
  const journeys: Omit<JourneyDefinition, 'version' | 'status' | 'created_by' | 'updated_at' | 'tenant_id'>[] = [
    { ...base, id: 'j1_verification', name: 'Registro → verificación pendiente', purpose: 'service', trigger: { event_type: 'player.registered' }, exit_on: ['player.verified'], entry: 'wait24', nodes: [
      { id: 'wait24', type: 'wait', duration_ms: DAY, next: 'still_pending' },
      { id: 'still_pending', type: 'condition', rule: { field: 'kyc', op: 'eq', value: 'pending' }, on_true: 'remind', on_false: 'end' },
      { id: 'remind', type: 'message', channel: 'email', template: 'verify_reminder', next: 'end' },
      { id: 'end', type: 'exit' }] },
    { ...base, id: 'j3_reward_notice', name: 'Recompensa confirmada → aviso', purpose: 'marketing', control_group_pct: 10, trigger: { event_type: 'reward.granted' }, entry: 'notify', nodes: [
      { id: 'notify', type: 'message', channel: 'inapp', template: 'reward_granted', next: 'email' },
      { id: 'email', type: 'message', channel: 'email', template: 'reward_granted', next: 'end' },
      { id: 'end', type: 'exit' }] },
    { ...base, id: 'j4_loyalty_halfway', name: 'Nivel → cruce del 50 %', purpose: 'marketing', trigger: { event_type: 'loyalty.threshold_crossed' }, entry: 'notify', nodes: [
      { id: 'notify', type: 'message', channel: 'inapp', template: 'loyalty_halfway', next: 'end' },
      { id: 'end', type: 'exit' }] },
    { ...base, id: 'jx_welcome_bonus', name: 'Verificado → free spins de bienvenida', purpose: 'marketing', control_group_pct: 10, trigger: { event_type: 'player.verified' }, entry: 'grant', nodes: [
      { id: 'grant', type: 'grant_reward', reward_id: 'welcome_fs_10', next: 'end' },
      { id: 'end', type: 'exit' }] },
    // D6: intervención de juego responsable (servicio): nunca promociona ni otorga incentivos
    { ...base, id: 'jrg_intervention', name: 'Señal de riesgo → intervención de juego responsable', purpose: 'service', trigger: { event_type: 'rg.risk_signal' }, entry: 'level', nodes: [
      { id: 'level', type: 'condition', rule: { field: 'risk.level', op: 'eq', value: 'high' }, on_true: 'limits_inapp', on_false: 'check_in' },
      { id: 'limits_inapp', type: 'message', channel: 'inapp', template: 'rg_limits_reminder', next: 'limits_email' },
      { id: 'limits_email', type: 'message', channel: 'email', template: 'rg_limits_reminder', next: 'end' },
      { id: 'check_in', type: 'message', channel: 'inapp', template: 'rg_check_in', next: 'end' },
      { id: 'end', type: 'exit' }] },
  ];
  for (const j of journeys) {
    app.registry.saveDraft(author, j);
    app.registry.submit(author, j.id);
    app.registry.approve(approver, j.id);
    app.registry.publish(author, j.id);
  }
  // Recorrido 2 (recuperación) vive en identidad/PAM: CRM solo recibe estados.
  // Recorrido 5 (cambio JR) es comportamiento del runtime: cancela pendientes y suprime al revalidar.
}

let seq = 0;
/** Helper para crear eventos sintéticos. */
export function ev<T extends EventEnvelope['event_type']>(tenant_id: string, player_id: string, event_type: T, payload: EventEnvelope<T>['payload'], occurred_at: string, opts: Partial<EventEnvelope> = {}): EventEnvelope<T> {
  return { event_id: `evt-${++seq}-${event_type}`, event_type, schema_version: 1, tenant_id, brand_id: 'rumbawin', player_id, occurred_at, source: event_type.startsWith('player') ? 'ss1.pam' : event_type.startsWith('rg') ? 'ss1.rg' : event_type.startsWith('consent') ? 'ss1.pam' : 'ss1.wallet', correlation_id: `corr-${seq}`, payload, ...opts } as EventEnvelope<T>;
}

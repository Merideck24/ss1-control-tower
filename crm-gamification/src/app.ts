import { AuditLog } from './audit/audit.ts';
import { ChannelHub, MemoryAdapter } from './channels/channels.ts';
import { CopilotTools } from './copilot/tools.ts';
import type { EventEnvelope } from './domain/events.ts';
import { Ingestor } from './ingestion/ingestor.ts';
import type { JourneyDefinition } from './journeys/model.ts';
import { JourneyRegistry, type Actor } from './journeys/registry.ts';
import { JourneyRuntime } from './journeys/runtime.ts';
import { LoyaltyService } from './loyalty/loyalty.ts';
import { DEFAULT_POLICY, PolicyEngine } from './policy/policyEngine.ts';
import { MockBonusService, RewardService } from './rewards/rewards.ts';
import { DAY, systemClock, type Clock } from './shared/util.ts';

export type App = ReturnType<typeof createApp>;

/** Composición del módulo. En producción cada pieza se respalda en PostgreSQL/broker. */
export function createApp(clock: Clock = systemClock) {
  const audit = new AuditLog(clock);
  const ingestor = new Ingestor(clock);
  const policy = new PolicyEngine(clock);
  const channels = new ChannelHub(clock);
  const adapters = { inapp: new MemoryAdapter('inapp'), email: new MemoryAdapter('email'), webpush: new MemoryAdapter('webpush') };
  Object.values(adapters).forEach((a) => channels.register(a));
  const bonus = new MockBonusService(clock);
  const rewards = new RewardService(bonus, audit, clock);
  const loyalty = new LoyaltyService(clock);
  const registry = new JourneyRegistry(audit, clock);
  const runtime = new JourneyRuntime({
    registry, policy, profiles: ingestor, audit, clock,
    effects: { send: (r) => channels.send(r), recordNonDelivery: (r) => channels.recordNonDelivery(r), grant: (r) => rewards.grant(r) },
  });
  const copilot = new CopilotTools({ registry, policy, profiles: () => [...new Set(tenants)].flatMap((t) => ingestor.all(t)), audit, clock });
  const tenants: string[] = [];

  // bucle de eventos: proyección → fidelidad → recorridos
  ingestor.subscribe((e) => { loyalty.onEvent(e); runtime.onEvent(e); });
  bonus.onGranted = (e) => ingestor.ingest(e);
  loyalty.onThreshold = (e) => ingestor.ingest(e);

  return { clock, audit, ingestor, policy, channels, adapters, bonus, rewards, loyalty, registry, runtime, copilot, tenants };
}

/** Plantillas, política, catálogo, programa y los 5 primeros recorridos del piloto. */
export function seedTenant(app: App, tenant_id: string, brand_id = 'rumbawin') {
  app.tenants.push(tenant_id);
  app.policy.setPolicy(tenant_id, { ...DEFAULT_POLICY, brand_id });
  app.policy.markRgFeedSynced(tenant_id);
  const t = (key: string, category: 'transactional' | 'promotional', purpose: 'service' | 'marketing', es: [string, string], en: [string, string], pt: [string, string]) =>
    app.channels.addTemplate(tenant_id, { key, category, purpose, content: { es: { subject: es[0], body: es[1] }, en: { subject: en[0], body: en[1] }, pt: { subject: pt[0], body: pt[1] } } });
  t('verify_reminder', 'transactional', 'service', ['Completa tu verificación', 'Tu cuenta está casi lista: completa la verificación desde tu perfil.'], ['Complete your verification', 'Your account is almost ready: finish verification from your profile.'], ['Conclua sua verificação', 'Sua conta está quase pronta: conclua a verificação no seu perfil.']);
  t('security_confirmation', 'transactional', 'service', ['Tu cuenta fue recuperada', 'Confirmamos el cambio de acceso. Si no fuiste tú, contacta a soporte.'], ['Your account was recovered', 'We confirm the access change. If this was not you, contact support.'], ['Sua conta foi recuperada', 'Confirmamos a alteração de acesso. Se não foi você, fale com o suporte.']);
  t('reward_granted', 'promotional', 'marketing', ['Tienes una recompensa', 'Recibiste {{reward_type}} por {{amount}} {{currency}}. Vigente hasta {{expires_at}}.'], ['You have a reward', 'You received {{reward_type}} worth {{amount}} {{currency}}. Valid until {{expires_at}}.'], ['Você tem uma recompensa', 'Você recebeu {{reward_type}} de {{amount}} {{currency}}. Válido até {{expires_at}}.']);
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

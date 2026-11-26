import type { AuditLog } from '../audit/audit.ts';
import { buildVars, TRIGGER_VARS } from './vars.ts';
import type { ChannelHub, Locale } from '../channels/channels.ts';
import type { EventEnvelope } from '../domain/events.ts';
import { assignArm } from '../experiments/experiments.ts';
import { SplitTracker } from '../experiments/bandit.ts';
import type { PolicyEngine, Decision } from '../policy/policyEngine.ts';
import type { PlayerProfile } from '../profile/projection.ts';
import type { RewardService } from '../rewards/rewards.ts';
import { evaluate } from '../segments/segmentEngine.ts';
import type { Clock } from '../shared/util.ts';
import { hasIncentive, type JourneyDefinition, type JourneyNode } from './model.ts';
import type { JourneyRegistry } from './registry.ts';

export type InstanceStatus = 'running' | 'waiting' | 'completed' | 'exited' | 'cancelled' | 'held_out' | 'blocked_overlap' | 'preempted';
export type TraceStep = { at: string; node: string; type: JourneyNode['type'] | 'enter' | 'exit_event'; outcome: string; decision?: Decision; detail?: Record<string, unknown> };
export type JourneyInstance = {
  instance_id: string;
  tenant_id: string;
  player_id: string;
  journey_id: string;
  version: number; // versión fijada (CRM-03)
  arm: 'treatment' | 'control';
  status: InstanceStatus;
  current: string;
  wake_at?: string;
  trigger_event_id: string;
  correlation_id: string;
  trace: TraceStep[];
  /**
   * Datos del disparador que necesitan las plantillas (solo para eventos que aportan variables).
   * Tras una espera o un diferido por horario silencioso el evento ya no está en contexto; sin esto
   * el mensaje saldría con huecos (o el canal lo rechazaría por variables vacías).
   */
  trigger_payload?: { event_type: string; payload: unknown };
};

type ProfileSource = { get(tenant: string, player: string): PlayerProfile | undefined };

export type Effects = {
  send: ChannelHub['send'];
  recordNonDelivery: ChannelHub['recordNonDelivery'];
  grant: RewardService['grant'];
};

/**
 * Ejecutor de recorridos. Instancias con versión fijada, temporizadores persistentes
 * (wake_at), revalidación de política justo antes de cada efecto y pausa que impide
 * nuevos efectos desde SS1. `effects: null` ⇒ modo simulación/replay sin efectos externos.
 */
export class JourneyRuntime {
  #instances = new Map<string, JourneyInstance>();
  #byPlayer = new Map<string, JourneyInstance[]>(); // tenant::player → instancias
  #waiting = new Set<JourneyInstance>(); // instancias con temporizador pendiente
  #globalPause = new Set<string>(); // tenants con pausa general
  #registry: JourneyRegistry;
  #policy: PolicyEngine;
  #profiles: ProfileSource;
  #effects: Effects | null;
  #audit: AuditLog;
  #clock: Clock;
  #skipWaits: boolean;
  #deferred = new Map<string, string>(); // instance → message node diferido
  #splits: SplitTracker | null;

  constructor(deps: { registry: JourneyRegistry; policy: PolicyEngine; profiles: ProfileSource; effects: Effects | null; audit: AuditLog; clock: Clock; skipWaits?: boolean; splits?: SplitTracker }) {
    this.#splits = deps.splits ?? null;
    this.#registry = deps.registry; this.#policy = deps.policy; this.#profiles = deps.profiles; this.#effects = deps.effects; this.#audit = deps.audit; this.#clock = deps.clock;
    this.#skipWaits = deps.skipWaits ?? false;
  }

  setGlobalPause(tenant: string, paused: boolean, actor: string, reason: string) {
    paused ? this.#globalPause.add(tenant) : this.#globalPause.delete(tenant);
    this.#audit.record(tenant, actor, paused ? 'runtime.global_pause' : 'runtime.global_resume', tenant, { reason });
  }
  isGloballyPaused(tenant: string) { return this.#globalPause.has(tenant); }

  /** Punto de entrada para eventos ya ingeridos. */
  onEvent(e: EventEnvelope): JourneyInstance[] {
    const started: JourneyInstance[] = [];
    // salidas por evento (p.ej. player.verified termina el recordatorio de verificación)
    const mine = this.#byPlayer.get(`${e.tenant_id}::${e.player_id}`) ?? [];
    for (const inst of mine) {
      if (!['waiting', 'running'].includes(inst.status)) continue;
      const def = this.#registry.get(inst.tenant_id, inst.journey_id, inst.version);
      if (def?.exit_on?.includes(e.event_type)) {
        inst.status = 'exited'; inst.wake_at = undefined;
        inst.trace.push({ at: this.#now(), node: inst.current, type: 'exit_event', outcome: `exit_on:${e.event_type}` });
      }
    }
    // cambio de juego responsable ⇒ cancelar acciones de marketing pendientes (recorrido 5)
    if (e.event_type === 'rg.status_changed' && (e as EventEnvelope<'rg.status_changed'>).payload.status !== 'none') {
      for (const inst of mine) {
        if (inst.status === 'waiting') {
          const def = this.#registry.get(inst.tenant_id, inst.journey_id, inst.version);
          if (def?.purpose === 'marketing') {
            inst.status = 'cancelled'; inst.wake_at = undefined;
            inst.trace.push({ at: this.#now(), node: inst.current, type: 'exit_event', outcome: 'cancelled_by_rg_change' });
            this.#audit.record(e.tenant_id, 'system', 'journey.instance_cancelled', e.player_id, { instance: inst.instance_id, reason: 'rg_status_changed' });
          }
        }
      }
    }
    for (const def of this.#registry.live(e.tenant_id)) {
      if (def.trigger.event_type !== e.event_type || def.brand_id !== e.brand_id) continue;
      const instance_id = `${def.tenant_id}:${def.id}:v${def.version}:${e.player_id}:${e.event_id}`;
      if (this.#instances.has(instance_id)) continue; // evento duplicado ⇒ una sola instancia lógica
      if (def.status !== 'published' || this.#globalPause.has(e.tenant_id)) {
        this.#audit.record(e.tenant_id, 'system', 'journey.entry_skipped_paused', e.player_id, { journey: def.id, version: def.version });
        continue;
      }
      // D3: anti-solapamiento — un jugador está en un solo recorrido de marketing por grupo;
      // gana la prioridad mayor (empate: el que ya está en curso) y el perdedor queda registrado
      const pk0 = `${e.tenant_id}::${e.player_id}`;
      const ov = def.purpose === 'marketing' ? def.overlap : undefined;
      if (ov) {
        const rivals = (this.#byPlayer.get(pk0) ?? []).filter((i) => (i.status === 'running' || i.status === 'waiting') && i.journey_id !== def.id).map((i) => ({ i, d: this.#registry.get(i.tenant_id, i.journey_id, i.version) })).filter((x) => x.d?.purpose === 'marketing' && x.d.overlap?.group === ov.group);
        const stronger = rivals.find((x) => (x.d!.overlap!.priority ?? 0) >= (ov.priority ?? 0));
        const cooldownMs = (ov.cooldown_hours ?? 0) * 3_600_000;
        const recent = cooldownMs > 0 && (this.#byPlayer.get(pk0) ?? []).some((i) => i.status === 'completed' && i.journey_id !== def.id && Date.parse(i.trace.at(-1)!.at) > this.#clock.now().getTime() - cooldownMs && this.#registry.get(i.tenant_id, i.journey_id, i.version)?.overlap?.group === ov.group);
        if (stronger || recent) {
          const blocked: JourneyInstance = { instance_id, tenant_id: e.tenant_id, player_id: e.player_id, journey_id: def.id, version: def.version, arm: 'treatment', status: 'blocked_overlap', current: def.entry, trigger_event_id: e.event_id, correlation_id: e.correlation_id,
            trace: [{ at: this.#now(), node: def.entry, type: 'enter', outcome: stronger ? `blocked_by:${stronger.i.journey_id}` : `cooldown:${ov.group}` }] };
          this.#instances.set(instance_id, blocked);
          this.#byPlayer.set(pk0, [...(this.#byPlayer.get(pk0) ?? []), blocked]);
          this.#audit.record(e.tenant_id, 'system', 'journey.entry_blocked_overlap', e.player_id, { journey: def.id, group: ov.group, by: stronger?.i.journey_id ?? 'cooldown' });
          started.push(blocked);
          continue;
        }
        for (const x of rivals) {
          x.i.status = 'preempted'; x.i.wake_at = undefined; this.#waiting.delete(x.i); this.#deferred.delete(x.i.instance_id);
          x.i.trace.push({ at: this.#now(), node: x.i.current, type: 'exit_event', outcome: `preempted_by:${def.id}` });
          this.#audit.record(e.tenant_id, 'system', 'journey.instance_preempted', e.player_id, { instance: x.i.instance_id, by: def.id, group: ov.group });
        }
      }
      const arm = def.purpose === 'marketing' && def.control_group_pct ? assignArm(def.tenant_id, `${def.id}`, e.player_id, def.control_group_pct) : 'treatment';
      const inst: JourneyInstance = { instance_id, tenant_id: e.tenant_id, player_id: e.player_id, journey_id: def.id, version: def.version, arm, status: arm === 'control' ? 'held_out' : 'running', current: def.entry, trigger_event_id: e.event_id, correlation_id: e.correlation_id, trace: [{ at: this.#now(), node: def.entry, type: 'enter', outcome: arm }], ...(TRIGGER_VARS[e.event_type] ? { trigger_payload: { event_type: e.event_type, payload: e.payload } } : {}) };
      this.#instances.set(instance_id, inst);
      const pk = `${e.tenant_id}::${e.player_id}`;
      this.#byPlayer.set(pk, [...(this.#byPlayer.get(pk) ?? []), inst]);
      if (arm === 'treatment') this.#advance(inst, def, { event: e });
      started.push(inst);
    }
    return started;
  }

  /** Procesa temporizadores vencidos (llamado por un scheduler). */
  tick(): number {
    let n = 0;
    const now = this.#clock.now().getTime();
    for (const inst of this.#waiting) {
      if (inst.status !== 'waiting') { this.#waiting.delete(inst); continue; }
      if (this.#deferred.has(inst.instance_id) || !inst.wake_at || Date.parse(inst.wake_at) > now) continue;
      const def = this.#registry.get(inst.tenant_id, inst.journey_id, inst.version)!;
      if (def.status !== 'published' || this.#globalPause.has(inst.tenant_id)) continue; // en pausa: queda esperando
      const node = def.nodes.find((x) => x.id === inst.current)! as Extract<JourneyNode, { type: 'wait' }>;
      this.#waiting.delete(inst);
      inst.status = 'running'; inst.wake_at = undefined; inst.current = node.next;
      this.#advance(inst, def, {});
      n++;
    }
    return n;
  }

  #now() { return this.#clock.now().toISOString(); }

  #advance(inst: JourneyInstance, def: JourneyDefinition, ctx: { event?: EventEnvelope }) {
    for (let guard = 0; guard < 100 && inst.status === 'running'; guard++) {
      const node = def.nodes.find((n) => n.id === inst.current)!;
      const profile = this.#profiles.get(inst.tenant_id, inst.player_id);
      if (!profile) { inst.status = 'exited'; inst.trace.push({ at: this.#now(), node: node.id, type: node.type, outcome: 'profile_missing' }); return; }
      switch (node.type) {
        case 'exit':
          inst.status = 'completed';
          inst.trace.push({ at: this.#now(), node: node.id, type: 'exit', outcome: 'completed' });
          return;
        case 'condition': {
          const ok = evaluate(node.rule, profile, this.#clock.now());
          inst.trace.push({ at: this.#now(), node: node.id, type: 'condition', outcome: String(ok) });
          inst.current = ok ? node.on_true : node.on_false;
          break;
        }
        case 'split': {
          // simulación sin rastreador: primera variante con peso, sin registrar asignaciones
          const variant = this.#splits ? this.#splits.assign(inst.tenant_id, def.id, node, inst.player_id, this.#clock.now().getTime()).variant : (node.variants.find((v) => v.weight > 0) ?? node.variants[0]).id;
          const v = node.variants.find((x) => x.id === variant)!;
          inst.trace.push({ at: this.#now(), node: node.id, type: 'split', outcome: `variant:${v.id}`, detail: { label: v.label, mode: node.mode } });
          inst.current = v.next;
          break;
        }
        case 'wait':
          if (this.#skipWaits) {
            inst.trace.push({ at: this.#now(), node: node.id, type: 'wait', outcome: `simulated_skip ${Math.round(node.duration_ms / 3_600_000)}h` });
            inst.current = node.next;
            break;
          }
          inst.status = 'waiting';
          this.#waiting.add(inst);
          inst.wake_at = new Date(this.#clock.now().getTime() + node.duration_ms).toISOString();
          inst.trace.push({ at: this.#now(), node: node.id, type: 'wait', outcome: `until ${inst.wake_at}` });
          return;
        case 'message': {
          const decision = this.#policy.decide({ profile, purpose: def.purpose, channel: node.channel });
          const key = `${inst.instance_id}:${node.id}`;
          if (decision.kind === 'defer' && !this.#skipWaits) {
            // re-ejecuta este mismo nodo al despertar (revalidando política otra vez)
            inst.status = 'waiting'; inst.wake_at = decision.defer_until; inst.current = node.id;
            this.#waiting.add(inst);
            inst.trace.push({ at: this.#now(), node: node.id, type: 'message', outcome: 'deferred', decision });
            this.#effects?.recordNonDelivery({ idempotency_key: key, tenant_id: inst.tenant_id, player_id: inst.player_id, channel: node.channel, template: node.template, locale: (profile.locale?.value ?? 'es') as Locale, status: 'deferred', reason: `quiet_hours_until:${decision.defer_until}` });
            this.#deferred.set(inst.instance_id, node.id);
            return;
          }
          if (decision.kind === 'suppress') {
            inst.trace.push({ at: this.#now(), node: node.id, type: 'message', outcome: 'suppressed', decision });
            this.#effects?.recordNonDelivery({ idempotency_key: key, tenant_id: inst.tenant_id, player_id: inst.player_id, channel: node.channel, template: node.template, locale: (profile.locale?.value ?? 'es') as Locale, status: 'suppressed', reason: decision.reasons.join(',') });
            this.#audit.record(inst.tenant_id, 'system', 'delivery.suppressed', inst.player_id, { journey: def.id, version: def.version, node: node.id, reasons: decision.reasons, policy_version: decision.policy_version });
            inst.current = node.next;
            break;
          }
          const vars = this.#vars(profile, ctx.event ?? (inst.trigger_payload as EventEnvelope | undefined));
          const receipt = this.#effects?.send({ tenant_id: inst.tenant_id, player_id: inst.player_id, address: profile.email_masked?.value ?? inst.player_id, channel: node.channel, template: node.template, locale: (profile.locale?.value ?? 'es') as Locale, vars, idempotency_key: key });
          if (receipt?.status === 'accepted' && def.purpose === 'marketing') this.#policy.recordMarketingSend(profile, node.channel);
          inst.trace.push({ at: this.#now(), node: node.id, type: 'message', outcome: this.#effects ? receipt!.status : 'simulated_send', decision, detail: receipt ? { reason: receipt.reason } : { template: node.template, vars } });
          inst.current = node.next;
          break;
        }
        case 'grant_reward': {
          const decision = this.#policy.decide({ profile, purpose: 'marketing', incentive: true });
          if (decision.kind !== 'allow') {
            inst.trace.push({ at: this.#now(), node: node.id, type: 'grant_reward', outcome: 'suppressed', decision });
            this.#audit.record(inst.tenant_id, 'system', 'reward.suppressed', inst.player_id, { journey: def.id, version: def.version, reasons: decision.reasons, policy_version: decision.policy_version });
          } else {
            const g = this.#effects?.grant({ tenant_id: inst.tenant_id, player_id: inst.player_id, reward_id: node.reward_id, idempotency_key: `${inst.instance_id}:${node.id}`, actor: `journey:${def.id}@v${def.version}` });
            inst.trace.push({ at: this.#now(), node: node.id, type: 'grant_reward', outcome: g ? g.status : 'simulated_grant', decision, detail: g ? { reason: g.reason } : { reward_id: node.reward_id } });
          }
          inst.current = node.next;
          break;
        }
      }
    }
  }

  /** Reanuda nodos de mensaje diferidos por horario silencioso. */
  tickDeferred(): number {
    let n = 0;
    const now = this.#clock.now().getTime();
    for (const [id, nodeId] of this.#deferred) {
      const inst = this.#instances.get(id)!;
      if (inst.status !== 'waiting' || !inst.wake_at || Date.parse(inst.wake_at) > now) continue;
      const def = this.#registry.get(inst.tenant_id, inst.journey_id, inst.version)!;
      if (def.status !== 'published' || this.#globalPause.has(inst.tenant_id)) continue;
      this.#deferred.delete(id);
      this.#waiting.delete(inst);
      inst.status = 'running'; inst.wake_at = undefined; inst.current = nodeId;
      this.#advance(inst, def, {});
      n++;
    }
    return n;
  }

  /** Ejecuta wait-timers y diferidos. */
  runDue(): number { return this.tickDeferred() + this.tick(); }

  #vars(profile: PlayerProfile, e?: EventEnvelope): Record<string, string | number> {
    return buildVars(profile.player_id, e, (profile.locale?.value ?? 'es') as 'es' | 'en' | 'pt');
  }

  instances(tenant: string, filter?: { player_id?: string; journey_id?: string }) {
    return [...this.#instances.values()].filter((i) => i.tenant_id === tenant && (!filter?.player_id || i.player_id === filter.player_id) && (!filter?.journey_id || i.journey_id === filter.journey_id));
  }
}

/**
 * Simulación sin efectos (CRM-03): ejecuta una definición (borrador incluido) contra un
 * perfil con efectos externos deshabilitados y esperas saltadas. Devuelve la traza.
 */
export function simulateJourney(def: JourneyDefinition, profile: PlayerProfile, triggerEvent: EventEnvelope, deps: { policy: PolicyEngine; audit: AuditLog; clock: Clock }): { trace: TraceStep[]; status: InstanceStatus; incentive: boolean } {
  const asPublished = { ...def, status: 'published' as const };
  const registry = { live: () => [asPublished], get: () => asPublished } as unknown as JourneyRegistry;
  const rt = new JourneyRuntime({ registry, policy: deps.policy, profiles: { get: () => profile }, effects: null, audit: deps.audit, clock: deps.clock, skipWaits: true });
  const [inst] = rt.onEvent({ ...triggerEvent, event_type: def.trigger.event_type, tenant_id: def.tenant_id, brand_id: def.brand_id, player_id: profile.player_id } as EventEnvelope);
  return inst ? { trace: inst.trace, status: inst.status, incentive: hasIncentive(def) } : { trace: [], status: 'exited', incentive: hasIncentive(def) };
}

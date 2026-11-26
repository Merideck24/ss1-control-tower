/**
 * Cola de fallas de entrega y reproceso manual (Fase 2, incremento 2).
 *
 * Una falla es un recibo `failed` (el proveedor rechazó o no se pudo llamar: no hubo efecto) o
 * `uncertain` (se llamó y no hubo respuesta: el proveedor pudo aceptarlo). El reproceso:
 *   1. bloquea la falla (dos solicitudes simultáneas no duplican el efecto);
 *   2. si es incierta, CONCILIA con el proveedor antes de reenviar; si lo tenía, queda aceptada sin reenviar;
 *   3. revalida el recorrido (versión original, no pausado ni cerrado) y la política vigente;
 *   4. reenvía con la MISMA clave de idempotencia y la versión original;
 *   5. deja rastro de cada intento: actor, fecha, motivo, resultado.
 */
import type { AuditLog } from '../audit/audit.ts';
import type { JourneyRegistry } from '../journeys/registry.ts';
import type { PolicyEngine } from '../policy/policyEngine.ts';
import type { PlayerProfile } from '../profile/projection.ts';
import { DomainError, type Clock } from '../shared/util.ts';
import { isSent, type ChannelHub, type Receipt } from './channels.ts';

export type FailureClass = 'transitoria' | 'requiere_correccion' | 'incierta';
export type ReprocessOutcome = 'accepted' | 'failed' | 'uncertain' | 'reconciled_accepted' | 'blocked_by_policy' | 'deferred' | 'blocked_by_journey' | 'needs_reconciliation';
export type ReprocessAttempt = { at: string; actor: string; reason: string; outcome: ReprocessOutcome; detail: string };
export type FailureView = {
  key: string; tenant_id: string; brand_id: string | null; player_id: string;
  journey_id: string | null; version: number | null; instance_id: string | null; node_id: string | null;
  channel: string; template: string; at: string; status: 'failed' | 'uncertain' | 'resolved';
  reason: string; reason_text: string; attempts: number; class: FailureClass;
  instructions: string[]; external_effect: string; history: ReprocessAttempt[];
};
export type FailureFilter = { brand?: string; journey?: string; channel?: string; status?: string; reason?: string; from?: string; to?: string; include_resolved?: boolean };

/** Cada motivo con su clase y lo que el operador debe revisar antes de reprocesar. */
function explain(reason: string, status: Receipt['status']): { cls: FailureClass; text: string; steps: string[] } {
  const [k, v] = reason.split(':');
  if (status === 'uncertain' || k === 'provider_timeout' || k === 'provider_error') return { cls: 'incierta', text: 'El proveedor no respondió a tiempo: pudo haber aceptado el mensaje.', steps: ['El reproceso primero pregunta al proveedor si tiene el mensaje con esta clave.', 'Si lo tiene, se marca como aceptado y no se reenvía.', 'Si el proveedor no puede responder, espera y vuelve a intentar: no se reenvía a ciegas.'] };
  if (k === 'provider_unavailable' || k === 'rate_limited' || k === 'network') return { cls: 'transitoria', text: 'El proveedor no estaba disponible.', steps: ['Revisa el estado del proveedor del canal.', 'Si ya se recuperó, reprocesa: se usa la misma clave, así que el proveedor descarta duplicados.'] };
  if (k === 'template_vars_missing') return { cls: 'requiere_correccion', text: `A la plantilla le faltaron datos: ${v ?? ''}.`, steps: ['Revisa que el evento que disparó el recorrido traiga esos datos.', 'Corrige la plantilla o el recorrido; reprocesar sin corregir vuelve a fallar.'] };
  if (k === 'template_not_found') return { cls: 'requiere_correccion', text: 'La plantilla no existe en este tenant.', steps: ['Crea o restaura la plantilla en Plantillas.', 'Después reprocesa.'] };
  if (k === 'channel_not_configured') return { cls: 'requiere_correccion', text: 'El canal no está configurado.', steps: ['Configura el proveedor del canal en Integraciones.', 'Después reprocesa.'] };
  if (k.startsWith('no_contact_for_')) return { cls: 'requiere_correccion', text: `El PAM no tiene contacto para ${k.replace('no_contact_for_', '')}.`, steps: ['Confirma en el PAM si el jugador tiene ese contacto.', 'Si no lo tiene, no reproceses: elige otro canal en el recorrido.'] };
  if (k === 'address_rejected' || k === 'invalid_address') return { cls: 'requiere_correccion', text: 'El proveedor rechazó la dirección.', steps: ['Verifica el contacto del jugador en el PAM.', 'Reprocesar con la misma dirección volverá a fallar.'] };
  return { cls: 'requiere_correccion', text: `Motivo del proveedor: ${reason}.`, steps: ['Revisa el registro del proveedor con la clave de idempotencia.', 'Reprocesa solo si la causa ya se corrigió.'] };
}

export class FailureQueue {
  #hub: ChannelHub; #policy: PolicyEngine; #registry: JourneyRegistry; #audit: AuditLog; #clock: Clock;
  #profile: (tenant: string, player: string) => PlayerProfile | undefined;
  #locks = new Set<string>();
  #history = new Map<string, ReprocessAttempt[]>();
  /** Motivo y estado de la falla cuando se pidió el primer reproceso (el recibo resuelto ya no lo tiene). */
  #original = new Map<string, { reason: string; status: Receipt['status'] }>();
  /** Gancho de persistencia: se espera ANTES del efecto externo (escritura previa y bloqueo en la base). */
  beforeEffect?: (tenant: string, key: string, actor: string) => Promise<void>;
  constructor(d: { hub: ChannelHub; policy: PolicyEngine; registry: JourneyRegistry; audit: AuditLog; clock: Clock; profile: (tenant: string, player: string) => PlayerProfile | undefined }) {
    this.#hub = d.hub; this.#policy = d.policy; this.#registry = d.registry; this.#audit = d.audit; this.#clock = d.clock; this.#profile = d.profile;
  }

  #view(r: Receipt): FailureView {
    const o = r.origin;
    const resolved = !(r.status === 'failed' || r.status === 'uncertain');
    const orig = resolved ? this.#original.get(r.idempotency_key) : undefined;
    const reason = orig?.reason ?? r.reason ?? '';
    const ex0 = explain(reason, orig?.status ?? r.status);
    const ex = resolved ? { ...ex0, text: `Resuelta: quedó ${({ accepted: 'aceptada', delivered: 'entregada', suppressed: 'suprimida por la política', deferred: 'aplazada' } as Record<string, string>)[r.status] ?? r.status}. Motivo original: ${ex0.text}` } : ex0;
    return {
      key: r.idempotency_key, tenant_id: r.tenant_id, brand_id: this.#profile(r.tenant_id, r.player_id)?.brand_id ?? null, player_id: r.player_id,
      journey_id: o?.journey_id ?? null, version: o?.version ?? null, instance_id: o?.instance_id ?? null, node_id: o?.node_id ?? null,
      channel: r.channel, template: r.template, at: r.at, status: resolved ? 'resolved' : (r.status as 'failed' | 'uncertain'),
      reason, reason_text: ex.text, attempts: r.attempts, class: ex.cls, instructions: ex.steps,
      external_effect: ex.cls === 'incierta'
        ? 'Primero se concilia con el proveedor. Solo si confirma que no tiene el mensaje se reenvía, y el reenvío puede llegar al jugador.'
        : 'Reprocesar envía el mensaje al jugador si la política lo permite hoy: es un efecto externo y no se puede deshacer.',
      history: this.#history.get(r.idempotency_key) ?? [],
    };
  }

  list(tenant: string, f: FailureFilter = {}): FailureView[] {
    const from = f.from ? Date.parse(f.from) : -Infinity, to = f.to ? Date.parse(f.to) : Infinity;
    return this.#hub.receipts(tenant)
      .filter((r) => r.status === 'failed' || r.status === 'uncertain' || (f.include_resolved && this.#history.has(r.idempotency_key)))
      .map((r) => this.#view(r))
      .filter((v) => (!f.brand || v.brand_id === f.brand) && (!f.journey || v.journey_id === f.journey) && (!f.channel || v.channel === f.channel)
        && (!f.status || v.status === f.status || v.class === f.status) && (!f.reason || v.reason.startsWith(f.reason))
        && Date.parse(v.at) >= from && Date.parse(v.at) <= to)
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  get(tenant: string, key: string): FailureView | undefined {
    const r = this.#hub.receipt(tenant, key);
    return r && (r.status === 'failed' || r.status === 'uncertain' || this.#history.has(key)) ? this.#view(r) : undefined;
  }

  async reprocess(actor: { id: string; tenant_id: string }, key: string, reason: string): Promise<{ outcome: ReprocessOutcome; detail: string; failure: FailureView }> {
    if (!reason.trim()) throw new DomainError('reason_required', 'Escribe el motivo del reproceso: queda en la auditoría.');
    const r0 = this.#hub.receipt(actor.tenant_id, key);
    if (!r0) throw new DomainError('not_found', 'No existe esa falla en este tenant.');
    if (!(r0.status === 'failed' || r0.status === 'uncertain')) throw new DomainError('not_reprocessable', `Esta entrega ya no es una falla (estado: ${r0.status}). No se reprocesa.`);
    if (this.#locks.has(key)) throw new DomainError('reprocess_in_progress', 'Otro operador está reprocesando esta falla. Espera el resultado.');
    this.#locks.add(key);
    if (!this.#original.has(key)) this.#original.set(key, { reason: r0.reason ?? '', status: r0.status });
    const record = (outcome: ReprocessOutcome, detail: string) => {
      const a: ReprocessAttempt = { at: this.#clock.now().toISOString(), actor: actor.id, reason, outcome, detail };
      this.#history.set(key, [...(this.#history.get(key) ?? []), a]);
      this.#audit.record(actor.tenant_id, actor.id, 'failure.reprocessed', key, { reason, outcome, detail, journey: r0.origin?.journey_id ?? null, version: r0.origin?.version ?? null, channel: r0.channel });
      return { outcome, detail, failure: this.#view(this.#hub.receipt(actor.tenant_id, key)!) };
    };
    try {
      this.#audit.record(actor.tenant_id, actor.id, 'failure.reprocess_requested', key, { reason, status: r0.status });
      await this.beforeEffect?.(actor.tenant_id, key, actor.id);
      const r = this.#hub.receipt(actor.tenant_id, key)!;
      if (!(r.status === 'failed' || r.status === 'uncertain')) return record('reconciled_accepted', `Mientras tanto quedó en estado ${r.status}: no se reenvió.`);
      // 1. incierta → conciliar antes de reenviar
      if (r.status === 'uncertain') {
        const c = this.#hub.reconcile(actor.tenant_id, key);
        if (c === 'accepted') return record('reconciled_accepted', 'El proveedor ya tenía el mensaje: se marcó aceptado sin reenviar.');
        if (c === 'unavailable') return record('needs_reconciliation', 'El proveedor no pudo confirmar si tiene el mensaje. No se reenvió; vuelve a intentar más tarde.');
      }
      // 2. recorrido: misma versión, no pausado ni cerrado
      const o = r.origin;
      if (o) {
        const def = this.#registry.get(actor.tenant_id, o.journey_id, o.version);
        if (!def) return record('blocked_by_journey', `La versión v${o.version} del recorrido ya no existe.`);
        if (def.status === 'closed') return record('blocked_by_journey', `El recorrido ${o.journey_id} está cerrado: no se reenvía.`);
        if (def.status === 'paused') return record('blocked_by_journey', `El recorrido ${o.journey_id} está en pausa: reanúdalo antes de reprocesar.`);
      }
      // 3. política vigente
      const profile = this.#profile(actor.tenant_id, r.player_id);
      if (!profile) return record('blocked_by_policy', 'El jugador ya no está en el CRM.');
      const purpose = o?.purpose ?? this.#hub.template(actor.tenant_id, r.template)?.purpose ?? 'marketing';
      const d = this.#policy.decide({ profile, purpose, channel: r.channel });
      if (d.kind === 'defer') return record('deferred', `Horario silencioso del jugador: se puede reprocesar desde ${d.defer_until}.`);
      if (d.kind === 'suppress') {
        this.#hub.recordNonDelivery({ idempotency_key: key, tenant_id: r.tenant_id, player_id: r.player_id, channel: r.channel, template: r.template, locale: r.locale, status: 'suppressed', reason: d.reasons.join(','), ...(r.origin ? { origin: r.origin } : {}) });
        return record('blocked_by_policy', `La política vigente lo impide hoy (${d.reasons.join(', ')}): se cerró como suprimida.`);
      }
      // 4. reenvío con la misma clave y versión
      const next = this.#hub.send({ tenant_id: r.tenant_id, player_id: r.player_id, address: r.address ?? r.player_id, channel: r.channel, template: r.template, locale: r.locale, vars: r.vars ?? {}, idempotency_key: key, ...(r.origin ? { origin: r.origin } : {}) }, { afterReconcile: true });
      if (isSent(next.status)) {
        if (purpose === 'marketing') this.#policy.recordMarketingSend(profile, r.channel);
        return record('accepted', `Aceptado por el proveedor${next.provider_message_id ? ` (${next.provider_message_id})` : ''}.`);
      }
      return record(next.status === 'uncertain' ? 'uncertain' : 'failed', `Volvió a fallar: ${next.reason ?? next.status}.`);
    } finally {
      this.#locks.delete(key);
    }
  }
}

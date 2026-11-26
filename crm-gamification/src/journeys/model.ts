import { ruleText } from '../segments/ruleText.ts';
import type { Channel, EventType, Purpose } from '../domain/events.ts';
import type { RuleNode } from '../segments/segmentEngine.ts';
import type { SplitNode } from '../experiments/bandit.ts';
import { EVENT_TYPES } from '../domain/events.ts';

export type JourneyNode =
  | { id: string; type: 'condition'; rule: RuleNode; on_true: string; on_false: string }
  | { id: string; type: 'wait'; duration_ms: number; next: string }
  | { id: string; type: 'message'; channel: Channel; template: string; next: string }
  | { id: string; type: 'grant_reward'; reward_id: string; next: string }
  | { id: string; type: 'exit' }
  | SplitNode;

export type JourneyStatus = 'draft' | 'pending_approval' | 'approved' | 'published' | 'paused' | 'archived';

export type JourneyDefinition = {
  id: string;
  tenant_id: string;
  brand_id: string;
  name: string;
  version: number;
  status: JourneyStatus;
  purpose: Purpose;
  trigger: { event_type: EventType };
  exit_on?: EventType[];
  entry: string;
  nodes: JourneyNode[];
  control_group_pct?: number; // solo marketing
  /** D3: anti-solapamiento. Mismo grupo ⇒ un solo recorrido activo por jugador; gana la prioridad mayor. */
  overlap?: { group: string; priority: number; cooldown_hours?: number };
  /** Posiciones en el lienzo del constructor visual (solo presentación). */
  layout?: Record<string, { x: number; y: number }>;
  created_by: string;
  approved_by?: string;
  approval_signature?: string;
  updated_at: string;
};

export const hasIncentive = (j: Pick<JourneyDefinition, 'nodes'>) => j.nodes.some((n) => n.type === 'grant_reward');

/** Valida estructura del grafo: nodos alcanzables, conexiones existentes, sin ciclos. */
export function validateJourney(j: Pick<JourneyDefinition, 'entry' | 'nodes' | 'purpose' | 'control_group_pct'> & { overlap?: JourneyDefinition['overlap'] }): string[] {
  const errs: string[] = [];
  if (!Array.isArray(j.nodes) || j.nodes.some((n) => !n || typeof n !== 'object')) return ['nodes_required'];
  const ids = new Map(j.nodes.map((n) => [n.id, n]));
  if (ids.size !== j.nodes.length) errs.push('duplicate_node_id');
  if (!ids.has(j.entry)) errs.push('entry_not_found');
  const nexts = (n: JourneyNode): string[] => (n.type === 'condition' ? [n.on_true, n.on_false] : n.type === 'split' ? n.variants.map((v) => v.next) : n.type === 'exit' ? [] : [n.next]);
  for (const n of j.nodes) for (const t of nexts(n)) if (!ids.has(t)) errs.push(`dangling_edge:${n.id}->${t}`);
  const state = new Map<string, 1 | 2>();
  const dfs = (id: string): void => {
    if (state.get(id) === 1) { errs.push(`cycle_at:${id}`); return; }
    if (state.get(id) === 2 || !ids.has(id)) return;
    state.set(id, 1);
    nexts(ids.get(id)!).forEach(dfs);
    state.set(id, 2);
  };
  dfs(j.entry);
  for (const n of j.nodes) if (!state.has(n.id)) errs.push(`unreachable:${n.id}`);
  if (j.purpose === 'service' && j.nodes.some((n) => n.type === 'grant_reward')) errs.push('service_journey_cannot_grant_incentives');
  if (j.purpose === 'service' && j.control_group_pct) errs.push('service_journey_cannot_have_control_group');
  if (!j.nodes.some((n) => n.type === 'exit')) errs.push('no_exit_node');
  for (const n of j.nodes) if (n.type === 'split') {
    if (!Array.isArray(n.variants) || n.variants.length < 2 || n.variants.length > 5) errs.push(`split_variants:${n.id}`);
    else if (new Set(n.variants.map((v) => v.id)).size !== n.variants.length || n.variants.some((v) => !v.id || !v.label?.trim())) errs.push(`split_variant_ids:${n.id}`);
    else if (n.mode === 'fixed' && !n.variants.some((v) => v.weight > 0)) errs.push(`split_weights:${n.id}`);
    if (!n.metric || !EVENT_TYPES.includes(n.metric.event) || !(n.metric.window_hours > 0)) errs.push(`split_metric:${n.id}`);
    if (n.mode !== 'fixed' && n.mode !== 'bandit') errs.push(`split_mode:${n.id}`);
  }
  if ((j as { trigger?: { event_type: string } }).trigger?.event_type === 'rg.risk_signal') {
    if (j.purpose !== 'service') errs.push('rg_journey_must_be_service');
    if (j.nodes.some((n) => n.type === 'grant_reward' || n.type === 'split')) errs.push('rg_journey_no_incentives_or_tests');
  }
  if (j.overlap && (!j.overlap.group?.trim() || !(j.overlap.priority >= 1 && j.overlap.priority <= 100))) errs.push('invalid_overlap');
  if (j.purpose === 'service' && j.overlap) errs.push('service_journey_cannot_have_overlap');
  return [...new Set(errs)];
}

/** Vista accesible en lista (alternativa al lienzo). */
/**
 * Vista accesible en lista (alternativa al lienzo), en lenguaje claro: pasos numerados en vez de
 * identificadores internos y condiciones como frases («KYC es Pendiente»). El grafo técnico sigue en `nodes`.
 */
export function journeyAsList(j: JourneyDefinition, names: { reward?: (id: string) => string | undefined; template?: (key: string) => string | undefined } = {}): string[] {
  // orden de lectura: desde el inicio, siguiendo las conexiones; luego los pasos sueltos
  const order: string[] = [];
  const visit = (id?: string) => {
    if (!id || order.includes(id)) return;
    const n = j.nodes.find((x) => x.id === id); if (!n) return;
    order.push(id);
    if (n.type === 'condition') { visit(n.on_true); visit(n.on_false); } else if (n.type === 'split') n.variants.forEach((v) => visit(v.next)); else if (n.type !== 'exit') visit(n.next);
  };
  visit(j.entry); for (const n of j.nodes) visit(n.id);
  const exitIds = new Set(j.nodes.filter((n) => n.type === 'exit').map((n) => n.id));
  const go = (id?: string) => (!id ? 'sin conectar' : exitIds.has(id) ? 'termina' : order.includes(id) ? `paso ${order.indexOf(id) + 1}` : `«${id}»`);
  // variables de la plantilla como campo legible: «¡Subiste a [nivel]!»
  const VARNAME: Record<string, string> = { level: 'nivel', previous_level: 'nivel anterior', percent: 'porcentaje', amount: 'monto', currency: 'moneda', reward_type: 'recompensa', expires_at: 'vencimiento', player_id: 'jugador' };
  const CH: Record<string, string> = { inapp: 'in-app', email: 'email', sms: 'SMS', whatsapp: 'WhatsApp', webpush: 'push web', telegram: 'Telegram' };
  const dur = (ms: number) => (ms % 86_400_000 === 0 ? `${ms / 86_400_000} ${ms === 86_400_000 ? 'día' : 'días'}` : `${Math.round((ms / 3_600_000) * 10) / 10} h`);
  return order.map((id, i) => {
    const n = j.nodes.find((x) => x.id === id)!;
    const k = `${i + 1}.`;
    switch (n.type) {
      case 'condition': return `${k} Si ${ruleText(n.rule as never)}: ${go(n.on_true)}; si no: ${go(n.on_false)}`;
      case 'wait': return `${k} Esperar ${dur(n.duration_ms)} → ${go(n.next)}`;
      case 'message': return `${k} Enviar «${(names.template?.(n.template) ?? n.template).replace(/\{\{(\w+)\}\}/g, (_m, v: string) => `[${VARNAME[v] ?? v}]`)}» por ${CH[n.channel] ?? n.channel} → ${go(n.next)}`;
      case 'grant_reward': return `${k} Otorgar «${names.reward?.(n.reward_id) ?? n.reward_id}» → ${go(n.next)}`;
      case 'exit': return `${k} Fin del recorrido`;
      case 'split': return `${k} Prueba A/B/n${n.mode === 'bandit' ? ' optimizada' : ''} (gana más ${n.metric.event === 'deposit.settled' ? 'depósitos' : n.metric.event} en ${n.metric.window_hours} h): ${n.variants.map((v) => `${v.label} → ${go(v.next)}`).join(' · ')}`;
    }
  });
}

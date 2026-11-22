import type { Channel, EventType, Purpose } from '../domain/events.ts';
import type { RuleNode } from '../segments/segmentEngine.ts';

export type JourneyNode =
  | { id: string; type: 'condition'; rule: RuleNode; on_true: string; on_false: string }
  | { id: string; type: 'wait'; duration_ms: number; next: string }
  | { id: string; type: 'message'; channel: Channel; template: string; next: string }
  | { id: string; type: 'grant_reward'; reward_id: string; next: string }
  | { id: string; type: 'exit' };

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
  created_by: string;
  approved_by?: string;
  approval_signature?: string;
  updated_at: string;
};

export const hasIncentive = (j: Pick<JourneyDefinition, 'nodes'>) => j.nodes.some((n) => n.type === 'grant_reward');

/** Valida estructura del grafo: nodos alcanzables, conexiones existentes, sin ciclos. */
export function validateJourney(j: Pick<JourneyDefinition, 'entry' | 'nodes' | 'purpose' | 'control_group_pct'>): string[] {
  const errs: string[] = [];
  const ids = new Map(j.nodes.map((n) => [n.id, n]));
  if (ids.size !== j.nodes.length) errs.push('duplicate_node_id');
  if (!ids.has(j.entry)) errs.push('entry_not_found');
  const nexts = (n: JourneyNode): string[] => (n.type === 'condition' ? [n.on_true, n.on_false] : n.type === 'exit' ? [] : [n.next]);
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
  return [...new Set(errs)];
}

/** Vista accesible en lista (alternativa al lienzo). */
export function journeyAsList(j: JourneyDefinition): string[] {
  return j.nodes.map((n) => {
    switch (n.type) {
      case 'condition': return `${n.id}: si ${JSON.stringify(n.rule)} → ${n.on_true}, si no → ${n.on_false}`;
      case 'wait': return `${n.id}: esperar ${Math.round(n.duration_ms / 3_600_000)} h → ${n.next}`;
      case 'message': return `${n.id}: enviar «${n.template}» por ${n.channel} → ${n.next}`;
      case 'grant_reward': return `${n.id}: otorgar ${n.reward_id} → ${n.next}`;
      case 'exit': return `${n.id}: salida`;
    }
  });
}

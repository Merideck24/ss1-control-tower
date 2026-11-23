import type { JourneyDefinition, JourneyNode } from './model.ts';
import { validateJourney } from './model.ts';
import { validateRules } from '../segments/segmentEngine.ts';

/**
 * D2 · Soporte del constructor visual: posiciones automáticas en el lienzo y
 * revisión en vivo con mensajes en lenguaje claro, ligados al nodo afectado.
 * El lienzo solo es presentación: el grafo validado sigue siendo `nodes` + `entry`.
 */
export type Pos = { x: number; y: number };
export const NODE_W = 200;
export const NODE_H = 76;
const GAP_X = 60;
const GAP_Y = 56;

export const nextsOf = (n: JourneyNode): { to: string; label?: string }[] =>
  n.type === 'condition' ? [{ to: n.on_true, label: 'sí' }, { to: n.on_false, label: 'no' }] : n.type === 'exit' ? [] : [{ to: n.next }];

/** Capas por profundidad (camino más largo desde el inicio); ramas en columnas. Determinista. */
export function autoLayout(j: Pick<JourneyDefinition, 'entry' | 'nodes'>): Record<string, Pos> {
  const byId = new Map(j.nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const visit = (id: string, d: number, stack: Set<string>) => {
    const n = byId.get(id);
    if (!n || stack.has(id)) return; // ciclos o conexiones rotas: los informa la validación
    if ((depth.get(id) ?? -1) >= d) return;
    depth.set(id, d);
    stack.add(id);
    for (const e of nextsOf(n)) visit(e.to, d + 1, stack);
    stack.delete(id);
  };
  visit(j.entry, 0, new Set());
  let maxD = Math.max(-1, ...depth.values());
  for (const n of j.nodes) if (!depth.has(n.id)) depth.set(n.id, ++maxD); // inalcanzables al final
  const rows = new Map<number, string[]>();
  for (const n of j.nodes) { const d = depth.get(n.id)!; rows.set(d, [...(rows.get(d) ?? []), n.id]); }
  const out: Record<string, Pos> = {};
  const widest = Math.max(1, ...[...rows.values()].map((r) => r.length));
  for (const [d, ids] of rows) {
    const offset = ((widest - ids.length) * (NODE_W + GAP_X)) / 2;
    ids.forEach((id, i) => (out[id] = { x: 24 + offset + i * (NODE_W + GAP_X), y: 24 + d * (NODE_H + GAP_Y) }));
  }
  return out;
}

export type BuilderIssue = { node?: string; code: string; message: string; severity: 'error' | 'warning' };
export type BuilderContext = {
  template: (key: string) => { purpose: 'service' | 'marketing' } | undefined;
  reward: (id: string) => { approved: boolean } | undefined;
};

const MESSAGES: Record<string, (arg?: string) => string> = {
  duplicate_node_id: () => 'Hay dos pasos con el mismo identificador.',
  entry_not_found: () => 'Falta el paso de inicio: marca uno como «Inicio».',
  dangling_edge: (a) => `La conexión ${a} apunta a un paso que no existe.`,
  cycle_at: (a) => `El recorrido vuelve sobre sí mismo en «${a}»; los recorridos no pueden tener ciclos.`,
  unreachable: (a) => `El paso «${a}» no está conectado al inicio.`,
  service_journey_cannot_grant_incentives: () => 'Un recorrido de servicio no puede otorgar recompensas.',
  service_journey_cannot_have_control_group: () => 'Un recorrido de servicio no lleva grupo de control.',
  no_exit_node: () => 'Agrega al menos un paso «Salida».',
};

/** Validación estructural + chequeos de contenido, con mensajes legibles para el lienzo. */
export function reviewJourney(j: Pick<JourneyDefinition, 'entry' | 'nodes' | 'purpose' | 'control_group_pct' | 'trigger' | 'name'>, ctx: BuilderContext): BuilderIssue[] {
  const issues: BuilderIssue[] = [];
  for (const code of validateJourney(j)) {
    const [base, arg] = code.split(':');
    if (base === 'dangling_edge' && arg?.endsWith('->')) {
      const from = arg.slice(0, -2);
      issues.push({ node: from, code: 'unconnected', message: `Falta conectar una salida de «${from}».`, severity: 'error' });
      continue;
    }
    const node = base === 'unreachable' || base === 'cycle_at' ? arg : base === 'dangling_edge' ? arg?.split('->')[0] : undefined;
    issues.push({ ...(node ? { node } : {}), code: base, message: (MESSAGES[base] ?? (() => code))(arg), severity: 'error' });
  }
  if (!j.name?.trim()) issues.push({ code: 'name_required', message: 'Ponle un nombre al recorrido.', severity: 'error' });
  if (!j.trigger?.event_type) issues.push({ code: 'trigger_required', message: 'Elige el evento que inicia el recorrido.', severity: 'error' });
  for (const n of j.nodes) {
    if (n.type === 'message') {
      const t = ctx.template(n.template);
      if (!t) issues.push({ node: n.id, code: 'unknown_template', message: `La plantilla «${n.template}» no existe.`, severity: 'error' });
      else if (j.purpose === 'service' && t.purpose === 'marketing') issues.push({ node: n.id, code: 'marketing_template_in_service', message: `«${n.template}» es promocional y este recorrido es de servicio.`, severity: 'error' });
    }
    if (n.type === 'grant_reward') {
      const r = ctx.reward(n.reward_id);
      if (!r) issues.push({ node: n.id, code: 'unknown_reward', message: `La recompensa «${n.reward_id}» no está en el catálogo.`, severity: 'error' });
      else if (!r.approved) issues.push({ node: n.id, code: 'reward_not_approved', message: `La recompensa «${n.reward_id}» aún no está aprobada por cumplimiento.`, severity: 'error' });
    }
    if (n.type === 'wait' && !(n.duration_ms > 0)) issues.push({ node: n.id, code: 'invalid_wait', message: 'La espera debe ser mayor que cero.', severity: 'error' });
    if (n.type === 'wait' && n.duration_ms > 90 * 86_400_000) issues.push({ node: n.id, code: 'long_wait', message: 'Esperas de más de 90 días rara vez son útiles: revisa la duración.', severity: 'warning' });
    if (n.type === 'condition') {
      for (const e of validateRules(n.rule)) issues.push({ node: n.id, code: 'invalid_rule', message: e.startsWith('unknown_field:') ? `La condición usa el campo «${e.slice(14)}», que no existe.` : `La condición no es válida (${e}).`, severity: 'error' });
      if (n.on_true && n.on_true === n.on_false) issues.push({ node: n.id, code: 'same_branches', message: 'Las dos ramas llevan al mismo paso: la condición no cambia nada.', severity: 'warning' });
    }
  }
  if (j.purpose === 'marketing' && !j.control_group_pct) issues.push({ code: 'no_control_group', message: 'Sin grupo de control no se podrá medir el incremento real.', severity: 'warning' });
  return issues;
}

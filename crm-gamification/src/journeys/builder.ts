import type { JourneyDefinition, JourneyNode } from './model.ts';
import type { Template } from '../channels/channels.ts';
import { varsForTrigger } from './vars.ts';
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
  n.type === 'condition' ? [{ to: n.on_true, label: 'sí' }, { to: n.on_false, label: 'no' }] : n.type === 'split' ? n.variants.map((v) => ({ to: v.next, label: v.label })) : n.type === 'exit' ? [] : [{ to: n.next }];

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
  template: (key: string) => (Pick<Template, 'purpose'> & Partial<Pick<Template, 'content' | 'channels'>>) | undefined;
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
  split_variants: (a) => `El A/B/n «${a}» necesita entre 2 y 5 variantes.`,
  split_variant_ids: (a) => `Las variantes de «${a}» necesitan nombre e identificador distintos.`,
  split_weights: (a) => `En «${a}» al menos una variante debe tener peso mayor que cero.`,
  split_metric: (a) => `Elige en «${a}» el evento que cuenta como conversión y una ventana en horas.`,
  split_mode: (a) => `El modo de «${a}» debe ser fijo u optimizado.`,
  rg_journey_must_be_service: () => 'Un recorrido disparado por una señal de riesgo es una intervención: debe ser de servicio, no de marketing.',
  rg_journey_no_incentives_or_tests: () => 'Las intervenciones de juego responsable no llevan recompensas ni pruebas A/B.',
  invalid_overlap: () => 'El grupo de solapamiento necesita nombre y una prioridad entre 1 y 100.',
  service_journey_cannot_have_overlap: () => 'Los recorridos de servicio no compiten con otros: quita el grupo de solapamiento.',
};

/** Validación estructural + chequeos de contenido, con mensajes legibles para el lienzo. */
export function reviewJourney(j: Pick<JourneyDefinition, 'entry' | 'nodes' | 'purpose' | 'control_group_pct' | 'trigger' | 'name' | 'overlap'>, ctx: BuilderContext): BuilderIssue[] {
  const issues: BuilderIssue[] = [];
  for (const code of validateJourney(j)) {
    const [base, arg] = code.split(':');
    if (base === 'dangling_edge' && arg?.endsWith('->')) {
      const from = arg.slice(0, -2);
      issues.push({ node: from, code: 'unconnected', message: `Falta conectar una salida de «${from}».`, severity: 'error' });
      continue;
    }
    const node = base === 'unreachable' || base === 'cycle_at' || base.startsWith('split_') ? arg : base === 'dangling_edge' ? arg?.split('->')[0] : undefined;
    issues.push({ ...(node ? { node } : {}), code: base, message: (MESSAGES[base] ?? (() => code))(arg), severity: 'error' });
  }
  if (!j.name?.trim()) issues.push({ code: 'name_required', message: 'Ponle un nombre al recorrido.', severity: 'error' });
  if (!j.trigger?.event_type) issues.push({ code: 'trigger_required', message: 'Elige el evento que inicia el recorrido.', severity: 'error' });
  for (const n of j.nodes) {
    if (n.type === 'message') {
      const t = ctx.template(n.template);
      if (!t) issues.push({ node: n.id, code: 'unknown_template', message: `La plantilla «${n.template}» no existe.`, severity: 'error' });
      else if (j.purpose === 'service' && t.purpose === 'marketing') issues.push({ node: n.id, code: 'marketing_template_in_service', message: `«${n.template}» es promocional y este recorrido es de servicio.`, severity: 'error' });
      if (t?.content) {
        // #2: una plantilla que pide variables que el disparador no trae sale con huecos
        const have = varsForTrigger(j.trigger?.event_type);
        // cuerpo y asunto en todos los idiomas, más la variante SMS o los parámetros de WhatsApp del canal elegido
        const texts = Object.values(t.content).map((c) => `${c?.subject ?? ''} ${c?.body ?? ''}`);
        if (n.channel === 'sms' && t.channels?.sms) texts.push(...Object.values(t.channels.sms));
        const need = [...new Set([...texts.flatMap((x) => [...String(x ?? '').matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])), ...(n.channel === 'whatsapp' ? t.channels?.whatsapp?.params ?? [] : [])])];
        const lacking = need.filter((k) => !have.includes(k));
        if (lacking.length) issues.push({ node: n.id, code: 'template_vars_unavailable', message: `«${n.template}» usa ${lacking.map((k) => `{{${k}}}`).join(', ')}, que el disparador «${j.trigger?.event_type ?? '—'}» no aporta. Elige una plantilla pensada para este recorrido.`, severity: 'error' });
      }
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
  for (const n of j.nodes) if (n.type === 'split' && n.mode === 'bandit' && (n.min_explore_pct ?? 10) < 5) issues.push({ node: n.id, code: 'low_exploration', message: 'Con menos de 5 % de exploración por variante el optimizador puede fijarse en una ganadora falsa.', severity: 'warning' });
  if (j.purpose === 'marketing' && !j.control_group_pct) issues.push({ code: 'no_control_group', message: 'Sin grupo de control no se podrá medir el incremento real.', severity: 'warning' });
  return issues;
}

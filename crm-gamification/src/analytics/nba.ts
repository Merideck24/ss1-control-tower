/**
 * Mejor acción siguiente (E4). Recomienda, no ejecuta.
 * - «No contactar» siempre es candidata y gana si nada aporta valor esperado positivo.
 * - Cada candidata pasa por el motor de políticas; una acción bloqueada nunca se recomienda.
 * - Jugadores con restricción de juego responsable: solo «no contactar» (nunca promoción).
 * Los efectos (uplift) son supuestos a calibrar con experimentos de control.
 */
import type { PolicyEngine } from '../policy/policyEngine.ts';
import type { PlayerProfile } from '../profile/projection.ts';
import type { PlayerPrediction } from './models.ts';
import type { Lifecycle } from './rfm.ts';

export type NbaAction = 'no_contact' | 'retention_offer' | 'deposit_nudge' | 'reactivation' | 'loyalty_progress' | 'vip_handover';
export const NBA_LABELS: Record<NbaAction, string> = {
  no_contact: 'No contactar', retention_offer: 'Oferta de retención', deposit_nudge: 'Empujón de depósito (mensaje)', reactivation: 'Reactivación',
  loyalty_progress: 'Aviso de progreso de fidelidad', vip_handover: 'Derivar a gestor VIP',
};
/** Supuestos (a calibrar con grupos de control): efecto relativo y costo. */
export const NBA_ASSUMPTIONS = {
  retention_offer: { uplift: 0.15, cost_minor: 20_000_00, channel: 'inapp' as const, incentive: true },
  deposit_nudge: { uplift: 0.05, cost_minor: 0, channel: 'inapp' as const, incentive: false },
  reactivation: { uplift: 0.08, cost_minor: 20_000_00, channel: 'email' as const, incentive: true },
  loyalty_progress: { uplift: 0.03, cost_minor: 0, channel: 'inapp' as const, incentive: false },
  vip_handover: { uplift: 0.1, cost_minor: 0, channel: 'inapp' as const, incentive: false },
};

export type NbaCandidate = { action: NbaAction; label: string; expected_value_minor: number; channel?: string; allowed: boolean; blocked_by?: string[]; why: string };
export type NbaResult = { player_id: string; chosen: NbaCandidate; candidates: NbaCandidate[]; note: string };

export function nextBestAction(p: PlayerProfile, pred: PlayerPrediction | undefined, ctx: { lifecycle: Lifecycle; loyaltyPct?: number; policy: PolicyEngine }): NbaResult {
  const value = Math.max(0, pred?.value_30d_minor ?? 0);
  const noContact: NbaCandidate = { action: 'no_contact', label: NBA_LABELS.no_contact, expected_value_minor: 0, allowed: true, why: 'Siempre disponible; evita contactos sin valor esperado.' };
  const out: NbaCandidate[] = [noContact];
  if (pred && !pred.promo_eligible) {
    return { player_id: p.player_id, chosen: noContact, candidates: out, note: 'Jugador con restricción de juego responsable: sin acciones promocionales. Si hay señales de riesgo, lo gestiona el equipo de juego responsable.' };
  }
  const add = (action: Exclude<NbaAction, 'no_contact'>, ev: number, why: string) => {
    const a = NBA_ASSUMPTIONS[action];
    const d = ctx.policy.decide({ profile: p, purpose: 'marketing', channel: a.channel, incentive: a.incentive });
    out.push({ action, label: NBA_LABELS[action], expected_value_minor: Math.round(ev), channel: a.channel, allowed: d.kind !== 'suppress', ...(d.kind === 'suppress' ? { blocked_by: d.reasons } : {}), why });
  };
  const churn = pred?.churn?.p ?? 0, dep = pred?.deposit?.p ?? 0;
  if (pred?.churn && churn >= 0.4) add('retention_offer', churn * NBA_ASSUMPTIONS.retention_offer.uplift * Math.max(value, 1) * 3 - NBA_ASSUMPTIONS.retention_offer.cost_minor, `Riesgo de abandono ${Math.round(churn * 100)} %; valor en juego ${Math.round(value / 100)} (3 meses).`);
  if (pred?.deposit && dep >= 0.2 && dep <= 0.75) add('deposit_nudge', NBA_ASSUMPTIONS.deposit_nudge.uplift * Math.max(value, 0), `Propensión media a depositar (${Math.round(dep * 100)} %): un recordatorio puede inclinarla.`);
  if (ctx.lifecycle === 'inactivo') add('reactivation', NBA_ASSUMPTIONS.reactivation.uplift * Math.max(value, 1) * 3 - NBA_ASSUMPTIONS.reactivation.cost_minor, 'Inactivo más de 30 días.');
  if ((ctx.loyaltyPct ?? 0) >= 50) add('loyalty_progress', NBA_ASSUMPTIONS.loyalty_progress.uplift * value, `Va al ${ctx.loyaltyPct} % del siguiente nivel.`);
  if (pred?.vip_early) add('vip_handover', NBA_ASSUMPTIONS.vip_handover.uplift * value * 6, 'VIP temprano: atención personal antes de que se enfríe.');
  // Solo acciones permitidas y con valor esperado positivo pueden ganar a «no contactar»
  const best = out.filter((c) => c.allowed && c.expected_value_minor > 0).sort((a, b) => b.expected_value_minor - a.expected_value_minor)[0] ?? noContact;
  return { player_id: p.player_id, chosen: best, candidates: out.sort((a, b) => b.expected_value_minor - a.expected_value_minor), note: 'Recomendación, no ejecución: requiere un recorrido aprobado. Efectos supuestos, a calibrar con grupos de control.' };
}

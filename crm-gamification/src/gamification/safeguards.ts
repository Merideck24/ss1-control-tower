/**
 * Salvaguardas de juego responsable comunes a retos, regalos, torneos y concursos (no configurables).
 */
import type { LoyaltyService } from '../loyalty/loyalty.ts';
import type { PlayerProfile } from '../profile/projection.ts';

export const DAY = 86_400_000;
/** Textos que invitan a recuperar pérdidas: se rechazan al guardar. */
export const LOSS_CHASING = /recuper\w*\s+(\p{L}+\s+){0,2}(lo\s+)?(perdid|p[eé]rdid)|chase\s+(your\s+)?loss|recupera\w*\s+(tu|su)\s+dinero|vuelve\s+a\s+ganar\s+lo\s+perdido/iu;
export const RISK_COOLDOWN_DAYS = 30;

/** Exclusión de gamificación, restricción de juego responsable, caso de riesgo abierto o señal reciente. */
export function rgIneligibility(d: { loyalty: LoyaltyService; riskHold?: (t: string, p: string) => boolean }, p: PlayerProfile, at: string): string[] {
  const r: string[] = [];
  if (d.loyalty.isOptedOut(p.tenant_id, p.player_id)) r.push('gamification_opt_out');
  if (!p.rg || p.rg.value !== 'none') r.push('rg_restricted');
  if (d.riskHold?.(p.tenant_id, p.player_id)) r.push('rg_risk_case_open');
  if (p.risk && Date.parse(p.risk.occurred_at) > Date.parse(at) - RISK_COOLDOWN_DAYS * DAY) r.push('vulnerability_signal');
  return r;
}

import type { AuditLog } from '../audit/audit.ts';
import { DAY, DomainError, type Clock } from '../shared/util.ts';
import type { PlayerFacts } from './performance.ts';

/**
 * G9 · Detección de abuso de bonos y escalado del bono por conducta.
 * Reglas explicables (sin caja negra): cada señal suma puntos y dice por qué.
 * El resultado no castiga al jugador por sí solo: limita o pausa incentivos y
 * deja la decisión final a una persona (revisión «descartado» / «confirmado»).
 */
export const ABUSE_RULES = {
  version: 'abuse-2026.11',
  bonus_window_days: 7, // vigencia típica para medir la apuesta asociada al bono
  heavy_ratio: 0.5, // bonos ≥ 50 % de los depósitos netos
  min_turnover_x: 1, // apostar menos de 1× el valor del bono en su vigencia
  cycle_hours: 48, // retiro poco después de un bono…
  cycle_turnover_x: 3, // …con menos de 3× el bono apostado entre medio
  bonus_only_share: 0.7, // ≥ 70 % de los días de juego caen justo después de un bono
  watch_score: 30,
  high_score: 60,
  watch_multiplier: 0.5,
  valuable_turnover_x: 10, // jugadores que apuestan ≥ 10× lo recibido pueden recibir bono escalado
  review_valid_days: 30,
} as const;

export type AbuseSignal = { code: 'bonus_heavy' | 'low_turnover' | 'bonus_withdraw_cycle' | 'bonus_only_activity' | 'linked_accounts'; points: number; label: string; detail: string };
export type AbuseTier = 'ok' | 'watch' | 'high';
export type AbuseReview = { status: 'cleared' | 'confirmed'; by: string; at: string; note: string; valid_until: string };
export type AbuseAssessment = {
  player_id: string;
  score: number;
  tier: AbuseTier;
  signals: AbuseSignal[];
  /** Multiplicador sugerido del bono: 0 = pausar incentivos hasta revisar. */
  multiplier: number;
  valuable: boolean;
  stats: { bonuses: number; bonus_minor: number; net_deposits_minor: number; bonus_turnover_x: number | null; withdrawals_after_bonus: number; linked: { player_id: string; via: 'device' | 'payment' }[] };
  review?: AbuseReview;
};

const H = 3_600_000;
const fmtX = (x: number) => `${x.toLocaleString('es-CO', { maximumFractionDigits: 1 })}×`;

export function assessPlayer(f: Readonly<PlayerFacts>, now: Date, linked: { player_id: string; via: 'device' | 'payment' }[], linkedWithBonus: (id: string) => boolean, review?: AbuseReview): AbuseAssessment {
  const R = ABUSE_RULES;
  const t = now.getTime();
  const bonuses = f.bonuses.filter((b) => b.at <= t).sort((a, b) => a.at - b.at);
  const bonusTotal = bonuses.reduce((s, b) => s + b.amount, 0);
  let deposits = 0;
  for (const [id, d] of f.deposits) if (d.at <= t && !f.reversed.has(id)) deposits += d.amount;
  const bets = f.bets.filter((b) => b.at <= t);
  const signals: AbuseSignal[] = [];

  // apuesta realizada dentro de la vigencia de cada bono
  let windowStake = 0;
  for (const b of bonuses) windowStake += bets.filter((x) => x.at >= b.at && x.at < b.at + R.bonus_window_days * DAY).reduce((s, x) => s + x.stake, 0);
  const turnoverX = bonusTotal > 0 ? windowStake / bonusTotal : null;

  if (bonuses.length >= 2 && bonusTotal >= R.heavy_ratio * Math.max(deposits, 1)) {
    signals.push({ code: 'bonus_heavy', points: 25, label: 'Depende de bonos', detail: `Recibió ${bonuses.length} bonos por el ${deposits > 0 ? Math.round((100 * bonusTotal) / deposits) + ' %' : 'total'} de lo que depositó.` });
  }
  // no usar el bono no es abuso: la señal exige haber jugado o retirado tras recibirlo
  const usedOrCashed = windowStake > 0 || f.withdrawals.some((w) => bonuses.some((b) => w.at > b.at && w.at <= t));
  if (turnoverX !== null && usedOrCashed && turnoverX < R.min_turnover_x && bonuses.some((b) => b.at + R.bonus_window_days * DAY <= t)) {
    signals.push({ code: 'low_turnover', points: 20, label: 'Apuesta poco el bono', detail: `En la vigencia de sus bonos apostó ${fmtX(turnoverX)} lo recibido (mínimo esperado ${fmtX(R.min_turnover_x)}).` });
  }
  let cycles = 0;
  for (const b of bonuses) {
    const w = f.withdrawals.find((x) => x.at > b.at && x.at <= b.at + R.cycle_hours * H && x.at <= t);
    if (!w) continue;
    const between = bets.filter((x) => x.at >= b.at && x.at <= w.at).reduce((s, x) => s + x.stake, 0);
    if (between < R.cycle_turnover_x * b.amount) cycles++;
  }
  if (cycles > 0) signals.push({ code: 'bonus_withdraw_cycle', points: cycles > 1 ? 35 : 25, label: 'Bono → retiro rápido', detail: `${cycles} ${cycles === 1 ? 'vez retiró' : 'veces retiró'} dentro de ${R.cycle_hours} h de recibir un bono, apostando menos de ${fmtX(R.cycle_turnover_x)} el bono.` });

  const betDays = new Set(bets.map((b) => Math.floor(b.at / DAY)));
  if (bonuses.length >= 2 && betDays.size >= 4) {
    const afterBonus = [...betDays].filter((d) => bonuses.some((b) => d * DAY + DAY > b.at && d * DAY < b.at + 3 * DAY)).length;
    if (afterBonus / betDays.size >= R.bonus_only_share) signals.push({ code: 'bonus_only_activity', points: 15, label: 'Solo juega con bono', detail: `${Math.round((100 * afterBonus) / betDays.size)} % de sus días de juego caen en los 3 días posteriores a un bono.` });
  }
  const linkedBonus = linked.filter((l) => linkedWithBonus(l.player_id));
  if (bonuses.length >= 1 && linkedBonus.length >= 1) {
    const vias = [...new Set(linkedBonus.map((l) => (l.via === 'device' ? 'dispositivo' : 'medio de pago')))].join(' y ');
    signals.push({ code: 'linked_accounts', points: linkedBonus.length >= 2 ? 45 : 35, label: 'Cuentas vinculadas', detail: `Comparte ${vias} con ${linkedBonus.length} ${linkedBonus.length === 1 ? 'cuenta que también recibió' : 'cuentas que también recibieron'} bonos.` });
  }

  const score = Math.min(100, signals.reduce((s, x) => s + x.points, 0));
  const tier: AbuseTier = score >= R.high_score ? 'high' : score >= R.watch_score ? 'watch' : 'ok';
  const valuable = tier === 'ok' && !f.rg_restricted && bonusTotal > 0 && turnoverX !== null && turnoverX >= R.valuable_turnover_x && deposits > bonusTotal;
  const activeReview = review && Date.parse(review.valid_until) > t ? review : undefined;
  let multiplier = tier === 'high' ? 0 : tier === 'watch' ? R.watch_multiplier : valuable ? 1.25 : 1;
  if (activeReview?.status === 'cleared') multiplier = Math.max(multiplier, 1);
  if (activeReview?.status === 'confirmed') multiplier = 0;
  return {
    player_id: f.player_id, score, tier, signals, multiplier, valuable,
    stats: { bonuses: bonuses.length, bonus_minor: bonusTotal, net_deposits_minor: deposits, bonus_turnover_x: turnoverX === null ? null : Math.round(turnoverX * 10) / 10, withdrawals_after_bonus: cycles, linked },
    ...(review ? { review } : {}),
  };
}

/** Revisiones humanas: descartar (falso positivo) o confirmar. Auditadas y con vigencia. */
export class AbuseReviews {
  #reviews = new Map<string, AbuseReview>();
  #audit: AuditLog;
  #clock: Clock;
  constructor(audit: AuditLog, clock: Clock) { this.#audit = audit; this.#clock = clock; }
  get(tenant: string, player: string) { return this.#reviews.get(`${tenant}::${player}`); }
  set(actor: { id: string; tenant_id: string }, player: string, status: string, note: string): AbuseReview {
    if (status !== 'cleared' && status !== 'confirmed') throw new DomainError('invalid_review', 'El estado debe ser «cleared» (descartar) o «confirmed» (confirmar).');
    if (!note || note.trim().length < 5) throw new DomainError('review_note_required', 'Escribe un motivo de al menos 5 caracteres.');
    const now = this.#clock.now();
    const r: AbuseReview = { status, by: actor.id, at: now.toISOString(), note: note.trim(), valid_until: new Date(now.getTime() + ABUSE_RULES.review_valid_days * DAY).toISOString() };
    this.#reviews.set(`${actor.tenant_id}::${player}`, r);
    this.#audit.record(actor.tenant_id, actor.id, `abuse.review_${status}`, player, { note: r.note, rules: ABUSE_RULES.version });
    return r;
  }
}

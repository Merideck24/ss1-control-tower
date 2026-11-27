/**
 * Impacto de los retos: retención D7/D30 por cohorte y comparación contra un grupo de control.
 *
 * Definiciones (también en docs/GAMIFICACION.md):
 * - Exposición: la primera vez que un jugador elegible queda expuesto al reto (se le muestra o genera
 *   actividad mientras el reto está activo). El grupo se asigna de forma estable por jugador y reto:
 *   tratamiento (ve el reto) o control (no lo ve). Se compara por intención de tratar: todos los
 *   expuestos del tratamiento, se inscriban o no, contra todos los del control.
 * - Retención Dn: el jugador tuvo actividad propia (apuesta liquidada, depósito o actividad en el sitio)
 *   entre el día n y el día n+7 desde su exposición (o inscripción, para las cohortes de participantes).
 *   Solo cuentan los jugadores "maduros": los que ya cumplieron n+7 días.
 * - Incremento: diferencia de tasas tratamiento − control con IC 95 % (aproximación normal). Es fiable
 *   con al menos `minPerArm` jugadores maduros por grupo.
 */
import { report } from '../experiments/experiments.ts';

const DAY = 86_400_000;
export const ACTIVITY_EVENTS = new Set(['bet.settled', 'deposit.settled', 'player.activity']);
export type Exposure = { player_id: string; arm: 'treatment' | 'control'; at: string };
export type RetentionRate = { mature: number; retained: number; rate: number | null };

/** Retención Dn para un conjunto de entradas (jugador, momento de entrada). */
export function retention(entries: { player_id: string; at: string }[], activity: (p: string) => number[], now: number, n: number, windowDays = 7): RetentionRate {
  let mature = 0, retained = 0;
  for (const e of entries) {
    const t0 = Date.parse(e.at), from = t0 + n * DAY, to = from + windowDays * DAY;
    if (to > now) continue;
    mature++;
    if (activity(e.player_id).some((t) => t >= from && t < to)) retained++;
  }
  return { mature, retained, rate: mature ? retained / mature : null };
}

const isoWeek = (iso: string) => {
  const d = new Date(iso.slice(0, 10) + 'T12:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow + 3);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const w = 1 + Math.round(((d.getTime() - first.getTime()) / DAY - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(w).padStart(2, '0')}`;
};

export function challengeImpact(input: {
  challenge_id: string; control_group_pct: number; exposures: Exposure[]; participants: { player_id: string; at: string }[];
  activity: (p: string) => number[]; now: number; minPerArm?: number;
}) {
  const minPerArm = input.minPerArm ?? 30;
  const arm = (a: 'treatment' | 'control') => input.exposures.filter((x) => x.arm === a);
  const t = arm('treatment'), c = arm('control');
  const lift = (n: number) => {
    const rt = retention(t, input.activity, input.now, n), rc = retention(c, input.activity, input.now, n);
    const r = report({ campaign: input.challenge_id, window: { from: '', to: '' }, primary_metric: `retención D${n}`, treatment: { n: rt.mature, conversions: rt.retained }, control: { n: rc.mature, conversions: rc.retained }, cost_minor: 0, currency: 'COP', min_n: minPerArm });
    return { treatment: rt, control: rc, diff: r.estimated_lift.absolute, ci95: r.estimated_lift.ci95, reliable: r.estimated_lift.reliable, note: r.estimated_lift.note ?? null };
  };
  const byWeek = new Map<string, { player_id: string; at: string }[]>();
  for (const p of input.participants) { const k = isoWeek(p.at); byWeek.set(k, [...(byWeek.get(k) ?? []), p]); }
  return {
    challenge_id: input.challenge_id, control_group_pct: input.control_group_pct, as_of: new Date(input.now).toISOString(),
    exposed: { treatment: t.length, control: c.length },
    d7: lift(7), d30: lift(30),
    participants: { n: input.participants.length, d7: retention(input.participants, input.activity, input.now, 7), d30: retention(input.participants, input.activity, input.now, 30) },
    cohorts: [...byWeek].sort(([a], [b]) => a.localeCompare(b)).map(([week, ps]) => ({ week, n: ps.length, d7: retention(ps, input.activity, input.now, 7), d30: retention(ps, input.activity, input.now, 30) })),
    definitions: {
      exposure: 'Primera vez que un jugador elegible queda expuesto al reto mientras está activo. El grupo (tratamiento o control) es estable por jugador y reto.',
      retention: 'Dn: actividad propia (apuesta liquidada, depósito o actividad en el sitio) entre el día n y el n+7 desde la exposición o la inscripción. Solo cuenta quien ya cumplió n+7 días.',
      lift: `Tratamiento − control por intención de tratar, con IC 95 %. Fiable con al menos ${minPerArm} jugadores maduros por grupo.`,
      cohorts: 'Participantes (inscritos) agrupados por la semana ISO de inscripción.',
    },
  };
}

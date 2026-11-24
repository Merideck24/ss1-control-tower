import { DAY } from '../shared/util.ts';
import type { PlayerFacts } from './performance.ts';

/**
 * H4 · Ranking de recorridos y recompensas por resultado incremental.
 * Todas las métricas se miden DESPUÉS de la entrada al recorrido y dentro de una
 * ventana fija, comparando tratamiento contra grupo de control. Así un recorrido cuya
 * entrada ya implica haber depositado (p. ej. cruce de nivel) no aparece con 100 %
 * de conversión: lo que cuenta es lo que pasa después.
 */
export type Entry = { journey_id: string; player_id: string; arm: 'treatment' | 'control'; at: number };
export type ArmOutcome = { n: number; deposit_rate: number; active_rate: number; ngr_per_player_minor: number; ngr_sd_minor: number };
export type JourneyImpact = {
  journey_id: string; window_days: number; mature: number; maturing: number;
  treatment: ArmOutcome; control: ArmOutcome;
  lift: { deposit_pp: number | null; ngr_per_player_minor: number | null; ngr_ci95_minor: [number, number] | null; incremental_ngr_minor: number | null; reliable: boolean; note?: string };
  cost_minor: number; roi: number | null; rank_score: number | null;
};

/** Resultado de un jugador en la ventana [entrada, entrada + W). */
function outcome(f: Readonly<PlayerFacts> | undefined, from: number, to: number, taxRate: number) {
  if (!f) return { deposited: false, active: false, ngr: 0 };
  let stake = 0, win = 0, bonus = 0, deposited = false, active = false;
  // estrictamente después de entrar: el depósito que dispara el recorrido no cuenta como resultado
  for (const d of f.deposits.values()) if (d.at > from && d.at < to) deposited = true;
  for (const b of f.bets) if (b.at >= from && b.at < to) { stake += b.stake; win += b.win; if (b.at >= from + 7 * DAY) active = true; }
  for (const b of f.bonuses) if (b.at >= from && b.at < to) bonus += b.amount;
  const ggr = stake - win;
  return { deposited, active, ngr: ggr - Math.max(0, ggr) * taxRate - bonus };
}

function arm(xs: { deposited: boolean; active: boolean; ngr: number }[]): ArmOutcome {
  const n = xs.length;
  const mean = n ? xs.reduce((s, x) => s + x.ngr, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x.ngr - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, deposit_rate: n ? xs.filter((x) => x.deposited).length / n : 0, active_rate: n ? xs.filter((x) => x.active).length / n : 0, ngr_per_player_minor: Math.round(mean), ngr_sd_minor: Math.round(sd) };
}

export function journeyImpact(entries: Entry[], facts: (player: string) => Readonly<PlayerFacts> | undefined, opts: { now: number; windowDays?: number; taxRate: number; costByJourney: (id: string) => number; minPerArm?: number }): JourneyImpact[] {
  const W = (opts.windowDays ?? 14) * DAY;
  const minN = opts.minPerArm ?? 100;
  const byJ = new Map<string, Entry[]>();
  for (const e of entries) byJ.set(e.journey_id, [...(byJ.get(e.journey_id) ?? []), e]);
  const out: JourneyImpact[] = [];
  for (const [id, es] of byJ) {
    const mature = es.filter((e) => e.at + W <= opts.now);
    const t = arm(mature.filter((e) => e.arm === 'treatment').map((e) => outcome(facts(e.player_id), e.at, e.at + W, opts.taxRate)));
    const c = arm(mature.filter((e) => e.arm === 'control').map((e) => outcome(facts(e.player_id), e.at, e.at + W, opts.taxRate)));
    const cost = opts.costByJourney(id);
    const hasControl = c.n > 0;
    const diff = hasControl ? t.ngr_per_player_minor - c.ngr_per_player_minor : null;
    const se = hasControl && t.n > 1 && c.n > 1 ? Math.sqrt(t.ngr_sd_minor ** 2 / t.n + c.ngr_sd_minor ** 2 / c.n) : null;
    const reliable = t.n >= minN && c.n >= minN;
    const incremental = diff === null ? null : diff * t.n;
    out.push({
      journey_id: id, window_days: W / DAY, mature: mature.length, maturing: es.length - mature.length, treatment: t, control: c,
      lift: { deposit_pp: hasControl ? t.deposit_rate - c.deposit_rate : null, ngr_per_player_minor: diff, ngr_ci95_minor: diff !== null && se !== null ? [Math.round(diff - 1.96 * se), Math.round(diff + 1.96 * se)] : null, incremental_ngr_minor: incremental, reliable,
        ...(hasControl ? (reliable ? {} : { note: `muestra insuficiente (<${minN} por brazo con ventana cumplida)` }) : { note: 'sin grupo de control: no se puede medir incremento' }) },
      cost_minor: cost, roi: incremental !== null && cost > 0 ? (incremental - cost) / cost : null,
      // orden: solo con control; incremento por jugador tratado, penalizado si el IC cruza cero
      rank_score: diff === null ? null : diff - (se ?? 0) * 1.0,
    });
  }
  return out.sort((a, b) => (b.rank_score ?? -Infinity) - (a.rank_score ?? -Infinity));
}

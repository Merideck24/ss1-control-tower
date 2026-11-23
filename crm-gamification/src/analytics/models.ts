/**
 * Modelos predictivos explicables (E1, E2, E3, E5).
 * - Regresión logística L2 sobre variables de comportamiento estandarizadas.
 * - Validación temporal: entrena con la foto de hace 60 días (etiqueta en los 30 siguientes) y valida con la de
 *   hace 30 días (etiqueta hasta hoy). Se compara contra una base simple.
 * - Sin señales de juego responsable como variables. Los jugadores restringidos no son elegibles para uso promocional.
 */
import type { PlayerFacts } from './performance.ts';
import { DAY } from '../shared/util.ts';

export const FEATURES = ['recency_days', 'tenure_days', 'deposits_30d', 'deposit_amount_30d', 'bets_14d', 'active_days_30d', 'ggr_30d', 'bonuses_30d'] as const;
export type FeatureName = (typeof FEATURES)[number];
export const FEATURE_LABELS: Record<FeatureName, string> = {
  recency_days: 'días desde la última actividad', tenure_days: 'antigüedad', deposits_30d: 'depósitos en 30 días', deposit_amount_30d: 'monto depositado en 30 días',
  bets_14d: 'apuestas en 14 días', active_days_30d: 'días activos en 30 días', ggr_30d: 'GGR en 30 días', bonuses_30d: 'bonos en 30 días',
};
const BOGOTA_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Bogota', hour: 'numeric', hourCycle: 'h23' });
const slog = (x: number) => Math.sign(x) * Math.log1p(Math.abs(x) / 100); // unidades mayores, escala logarítmica con signo

export function features(f: Readonly<PlayerFacts>, t: number): Record<FeatureName, number> | null {
  if (f.registered_at > t) return null;
  const acts = [...f.bets.map((b) => b.at), ...[...f.deposits.values()].map((d) => d.at)].filter((a) => a <= t);
  const last = acts.length ? Math.max(...acts) : f.registered_at;
  const in30 = (a: number) => a > t - 30 * DAY && a <= t;
  const deps30 = [...f.deposits.values()].filter((d) => in30(d.at));
  const days = new Set(acts.filter(in30).map((a) => Math.floor(a / DAY)));
  return {
    recency_days: Math.min(120, (t - last) / DAY),
    tenure_days: Math.min(365, (t - f.registered_at) / DAY),
    deposits_30d: deps30.length,
    deposit_amount_30d: slog(deps30.reduce((s, d) => s + d.amount, 0)),
    bets_14d: f.bets.filter((b) => b.at > t - 14 * DAY && b.at <= t).length,
    active_days_30d: days.size,
    ggr_30d: slog(f.bets.filter((b) => in30(b.at)).reduce((s, b) => s + b.stake - b.win, 0)),
    bonuses_30d: f.bonuses.filter((b) => in30(b.at)).length,
  };
}
const activeIn = (f: Readonly<PlayerFacts>, from: number, to: number) => f.bets.some((b) => b.at > from && b.at <= to) || [...f.deposits.values()].some((d) => d.at > from && d.at <= to);
const depositIn = (f: Readonly<PlayerFacts>, from: number, to: number) => [...f.deposits.values()].some((d) => d.at > from && d.at <= to);
const ngrIn = (f: Readonly<PlayerFacts>, from: number, to: number, tax: number) => {
  const ggr = f.bets.filter((b) => b.at > from && b.at <= to).reduce((s, b) => s + b.stake - b.win, 0);
  const bonus = f.bonuses.filter((b) => b.at > from && b.at <= to).reduce((s, b) => s + b.amount, 0);
  return ggr - bonus - Math.round(Math.max(0, ggr) * tax);
};

type Row = { x: number[]; y: number; id: string };
export type Logit = { mean: number[]; std: number[]; w: number[]; b: number };

export function fitLogit(rows: Row[], { l2 = 0.05, iters = 400, lr = 0.3 } = {}): Logit {
  const k = FEATURES.length;
  const mean = Array.from({ length: k }, (_, j) => rows.reduce((s, r) => s + r.x[j], 0) / Math.max(1, rows.length));
  const std = Array.from({ length: k }, (_, j) => Math.sqrt(rows.reduce((s, r) => s + (r.x[j] - mean[j]) ** 2, 0) / Math.max(1, rows.length)) || 1);
  const Z = rows.map((r) => r.x.map((v, j) => (v - mean[j]) / std[j]));
  const w = new Array(k).fill(0); let b = 0;
  const n = Math.max(1, rows.length);
  for (let it = 0; it < iters; it++) {
    const gw = new Array(k).fill(0); let gb = 0;
    for (let i = 0; i < rows.length; i++) {
      const p = 1 / (1 + Math.exp(-(b + Z[i].reduce((s, z, j) => s + z * w[j], 0))));
      const e = p - rows[i].y;
      for (let j = 0; j < k; j++) gw[j] += e * Z[i][j];
      gb += e;
    }
    for (let j = 0; j < k; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    b -= lr * (gb / n);
  }
  return { mean, std, w, b };
}
export function predictLogit(m: Logit, x: number[]): number {
  return 1 / (1 + Math.exp(-(m.b + x.reduce((s, v, j) => s + ((v - m.mean[j]) / m.std[j]) * m.w[j], 0))));
}
/** Contribuciones por variable (en logit) para explicar una predicción. */
export function explain(m: Logit, x: number[]): { feature: FeatureName; label: string; effect: number; value: number }[] {
  return FEATURES.map((f, j) => ({ feature: f, label: FEATURE_LABELS[f], effect: ((x[j] - m.mean[j]) / m.std[j]) * m.w[j], value: x[j] }))
    .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
}

/** AUC por rangos (Mann–Whitney) con empates promediados. */
export function auc(scores: number[], labels: number[]): number | null {
  const pos = labels.filter((y) => y === 1).length, neg = labels.length - pos;
  if (!pos || !neg) return null;
  const idx = scores.map((s, i) => [s, i] as const).sort((a, b) => a[0] - b[0]);
  const rank = new Array(scores.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) rank[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; }
  const sumPos = labels.reduce((s, y, i) => s + (y === 1 ? rank[i] : 0), 0);
  return (sumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}
export const brier = (p: number[], y: number[]) => (p.length ? p.reduce((s, v, i) => s + (v - y[i]) ** 2, 0) / p.length : null);

export type ModelReport = {
  name: 'churn' | 'deposit_propensity';
  label: string; population: string;
  train: { as_of: string; n: number; positives: number };
  validation: { as_of: string; n: number; positives: number; auc: number | null; brier: number | null; baseline_auc: number | null; baseline: string };
  coefficients: { feature: FeatureName; label: string; weight: number }[];
  usable: boolean;
};
export type PlayerPrediction = {
  churn: { p: number; reasons: string[] } | null;
  deposit: { p: number; reasons: string[] } | null;
  value_30d_minor: number | null;
  vip_early: boolean;
  preferences: { product: 'casino' | 'sports' | 'mixto' | null; casino_share: number | null; daypart: string | null; avg_stake_minor: number | null };
  promo_eligible: boolean;
};

const MIN_ROWS = 40;
/** Razones en lenguaje claro: nivel del valor frente a la media y hacia dónde empuja la predicción. */
const reasons = (m: Logit, x: number[], target: 'el riesgo' | 'la probabilidad') => explain(m, x).slice(0, 3).map((e) => {
  const j = FEATURES.indexOf(e.feature);
  return `${e.label} ${x[j] >= m.mean[j] ? 'alto' : 'bajo'}, ${e.effect >= 0 ? 'aumenta' : 'reduce'} ${target}`;
});

export function trainModels(facts: readonly Readonly<PlayerFacts>[], now: Date, opts: { taxRate: number }) {
  const T = now.getTime();
  const tTrain = T - 60 * DAY, tValid = T - 30 * DAY;
  const vec = (f: Readonly<PlayerFacts>, t: number) => { const x = features(f, t); return x ? FEATURES.map((k) => x[k]) : null; };
  // Abandono: base = jugadores activos en los 30 días previos; etiqueta = sin actividad en los 30 siguientes
  const churnRows = (t: number) => facts.filter((f) => activeIn(f, t - 30 * DAY, t)).flatMap((f) => { const x = vec(f, t); return x ? [{ x, y: activeIn(f, t, t + 30 * DAY) ? 0 : 1, id: f.player_id }] : []; });
  // Propensión: base = jugadores con FTD; etiqueta = deposita en los 30 siguientes
  const depRows = (t: number) => facts.filter((f) => f.ftd_at !== undefined && f.ftd_at <= t).flatMap((f) => { const x = vec(f, t); return x ? [{ x, y: depositIn(f, t, t + 30 * DAY) ? 1 : 0, id: f.player_id }] : []; });

  const build = (name: ModelReport['name'], label: string, population: string, rowsAt: (t: number) => Row[], baselineIdx: number, baselineSign: number, baselineName: string) => {
    const tr = rowsAt(tTrain), va = rowsAt(tValid);
    const model = fitLogit(tr);
    const p = va.map((r) => predictLogit(model, r.x));
    const y = va.map((r) => r.y);
    const report: ModelReport = {
      name, label, population,
      train: { as_of: new Date(tTrain).toISOString(), n: tr.length, positives: tr.filter((r) => r.y).length },
      validation: { as_of: new Date(tValid).toISOString(), n: va.length, positives: y.filter(Boolean).length, auc: auc(p, y), brier: brier(p, y), baseline_auc: auc(va.map((r) => baselineSign * r.x[baselineIdx]), y), baseline: baselineName },
      coefficients: FEATURES.map((f, j) => ({ feature: f, label: FEATURE_LABELS[f], weight: model.w[j] })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)),
      usable: tr.length >= MIN_ROWS && va.length >= MIN_ROWS,
    };
    // Se reentrena con la foto más reciente con etiqueta para puntuar hoy
    const final = fitLogit([...tr, ...va]);
    return { report, final };
  };
  const churn = build('churn', 'Riesgo de abandono a 30 días', 'Jugadores activos en los 30 días previos', churnRows, FEATURES.indexOf('recency_days'), 1, 'solo días desde la última actividad');
  const dep = build('deposit_propensity', 'Propensión a depositar en 30 días', 'Jugadores con primer depósito', depRows, FEATURES.indexOf('deposits_30d'), 1, 'solo depósitos de los últimos 30 días');

  // Valor a 30 días: P(depositar) × NGR medio de los últimos 30 días del jugador (o de la población activa)
  const recentNgr = (f: Readonly<PlayerFacts>, t: number) => ngrIn(f, t - 30 * DAY, t, opts.taxRate);
  const activeDepositors = facts.filter((f) => depositIn(f, tValid - 30 * DAY, tValid));
  const popMean = activeDepositors.length ? activeDepositors.reduce((s, f) => s + recentNgr(f, tValid), 0) / activeDepositors.length : 0;
  const valueAt = (f: Readonly<PlayerFacts>, t: number, m: Logit) => {
    const x = vec(f, t); if (!x || f.ftd_at === undefined || f.ftd_at > t) return null;
    const own = recentNgr(f, t);
    return Math.round(predictLogit(m, x) * (own !== 0 ? own : popMean));
  };
  // validación del valor: MAE frente a la base «igual que los 30 días anteriores»
  const vRows = facts.filter((f) => f.ftd_at !== undefined && f.ftd_at <= tValid);
  const mae = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + Math.abs(v), 0) / xs.length : null);
  const valueReport = {
    label: 'Valor previsto (NGR) a 30 días', method: 'P(depositar en 30 d) × NGR de los últimos 30 días del jugador (o media de depositantes activos si no tiene historial)',
    validation: { as_of: new Date(tValid).toISOString(), n: vRows.length,
      mae_minor: mae(vRows.map((f) => (valueAt(f, tValid, dep.final) ?? 0) - ngrIn(f, tValid, T, opts.taxRate))),
      baseline_mae_minor: mae(vRows.map((f) => recentNgr(f, tValid) - ngrIn(f, tValid, T, opts.taxRate))), baseline: 'NGR igual al de los 30 días anteriores' },
  };

  function predict(f: Readonly<PlayerFacts>): PlayerPrediction {
    const x = vec(f, T);
    const isActive = activeIn(f, T - 30 * DAY, T);
    const hasFtd = f.ftd_at !== undefined && f.ftd_at <= T;
    const bets = f.bets.filter((b) => b.at <= T);
    const stake = bets.reduce((s, b) => s + b.stake, 0);
    const casino = bets.filter((b) => b.product === 'casino').reduce((s, b) => s + b.stake, 0);
    const share = stake > 0 ? casino / stake : null;
    const hours = bets.map((b) => Number(BOGOTA_HOUR.format(b.at)) % 24);
    const band = (h: number) => (h < 6 ? 'madrugada' : h < 12 ? 'mañana' : h < 18 ? 'tarde' : 'noche');
    const counts = new Map<string, number>(); hours.forEach((h) => counts.set(band(h), (counts.get(band(h)) ?? 0) + 1));
    const daypart = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return {
      churn: x && isActive ? { p: predictLogit(churn.final, x), reasons: reasons(churn.final, x, 'el riesgo') } : null,
      deposit: x && hasFtd ? { p: predictLogit(dep.final, x), reasons: reasons(dep.final, x, 'la probabilidad') } : null,
      value_30d_minor: valueAt(f, T, dep.final),
      vip_early: false,
      preferences: { product: share === null ? null : share >= 0.7 ? 'casino' : share <= 0.3 ? 'sports' : 'mixto', casino_share: share, daypart, avg_stake_minor: bets.length ? Math.round(stake / bets.length) : null },
      promo_eligible: !f.rg_restricted,
    };
  }
  const all = new Map(facts.map((f) => [f.player_id, predict(f)]));
  // VIP temprano: antigüedad ≤ 30 d y valor previsto ≥ percentil 90 de los establecidos
  const established = facts.filter((f) => T - f.registered_at > 30 * DAY).map((f) => all.get(f.player_id)!.value_30d_minor).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const p90 = established.length ? established[Math.floor(0.9 * (established.length - 1))] : Infinity;
  for (const f of facts) { const pr = all.get(f.player_id)!; if (T - f.registered_at <= 30 * DAY && pr.value_30d_minor !== null && pr.value_30d_minor >= p90 && p90 > 0) pr.vip_early = true; }

  return { as_of: now.toISOString(), models: [churn.report, dep.report], value: valueReport, vip_threshold_minor: Number.isFinite(p90) ? p90 : null, predictions: all,
    notes: ['Modelos explicables entrenados por tenant; se reentrenan cuando cambian los datos.', 'El estado de juego responsable no es variable de ningún modelo; los jugadores restringidos se marcan como no elegibles para uso promocional.', 'Validación temporal: entrenamiento con la foto de hace 60 días y validación con la de hace 30.'] };
}
export type ModelBundle = ReturnType<typeof trainModels>;

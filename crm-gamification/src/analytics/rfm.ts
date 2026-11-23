/**
 * RFM y ciclo de vida (C2, C3).
 * - RFM: puntajes 1–5 por quintiles dentro del tenant, solo jugadores con depósito.
 *   R = días desde la última actividad (menos días ⇒ más puntos), F = depósitos, M = depósitos netos.
 * - Ciclo de vida: se calcula por jugador desde su línea de tiempo (no depende de la población).
 */
import type { PlayerProfile } from '../profile/projection.ts';
import { DAY } from '../shared/util.ts';

export type Lifecycle = 'sin_deposito' | 'nuevo' | 'activo' | 'en_riesgo' | 'inactivo' | 'reactivado';
export const LIFECYCLE_LABELS: Record<Lifecycle, string> = {
  sin_deposito: 'Registrado sin depósito', nuevo: 'Nuevo (FTD ≤ 14 d)', activo: 'Activo (≤ 14 d)', en_riesgo: 'En riesgo (15–30 d)', inactivo: 'Inactivo (> 30 d)', reactivado: 'Reactivado',
};
export const LIFECYCLE_WINDOWS = { newDays: 14, activeDays: 14, riskDays: 30, gapForReactivationDays: 30 };

const ACTIVITY = new Set(['bet.settled', 'deposit.settled']);

export function lifecycleOf(p: PlayerProfile, now: Date): Lifecycle {
  const ftd = p.stats.first_deposit_at ? Date.parse(p.stats.first_deposit_at) : undefined;
  if (ftd === undefined || ftd > now.getTime()) return 'sin_deposito';
  const acts = p.timeline.filter((t) => ACTIVITY.has(t.event_type)).map((t) => Date.parse(t.occurred_at)).filter((t) => t <= now.getTime()).sort((a, b) => a - b);
  const last = acts.at(-1) ?? ftd;
  const since = (now.getTime() - last) / DAY;
  if ((now.getTime() - ftd) / DAY <= LIFECYCLE_WINDOWS.newDays) return 'nuevo';
  if (since > LIFECYCLE_WINDOWS.riskDays) return 'inactivo';
  if (since > LIFECYCLE_WINDOWS.activeDays) return 'en_riesgo';
  // activo; ¿volvió tras una pausa larga dentro de la ventana activa?
  const recentStart = now.getTime() - LIFECYCLE_WINDOWS.activeDays * DAY;
  const firstRecent = acts.findIndex((t) => t >= recentStart);
  if (firstRecent > 0 && (acts[firstRecent] - acts[firstRecent - 1]) / DAY > LIFECYCLE_WINDOWS.gapForReactivationDays) return 'reactivado';
  return 'activo';
}

export type RfmScore = { r: number; f: number; m: number; segment: RfmSegment; recency_days: number; frequency: number; monetary_minor: number };
export type RfmSegment = 'campeones' | 'leales' | 'no_podemos_perderlos' | 'en_riesgo' | 'potenciales_leales' | 'nuevos' | 'necesitan_atencion' | 'hibernando';
export const RFM_LABELS: Record<RfmSegment, string> = {
  campeones: 'Campeones', leales: 'Leales', no_podemos_perderlos: 'No podemos perderlos', en_riesgo: 'En riesgo', potenciales_leales: 'Potenciales leales', nuevos: 'Nuevos', necesitan_atencion: 'Necesitan atención', hibernando: 'Hibernando',
};

/** Reglas en orden: la primera que cumple asigna el segmento. */
export function rfmSegment(r: number, f: number, m: number): RfmSegment {
  if (r >= 4 && f >= 4 && m >= 4) return 'campeones';
  if (r <= 2 && f >= 4 && m >= 4) return 'no_podemos_perderlos';
  if (r <= 2 && f >= 3) return 'en_riesgo';
  if (f >= 4) return 'leales';
  if (r >= 4 && f === 1) return 'nuevos';
  if (r >= 4 && f >= 2) return 'potenciales_leales';
  if (r === 3) return 'necesitan_atencion';
  return 'hibernando';
}

/** Puntaje por quintiles con empates estables: valores iguales reciben el mismo puntaje. */
function quintileScorer(values: number[], higherIsBetter: boolean) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return (v: number) => {
    if (n === 0) return 3;
    // proporción de valores estrictamente menores + mitad de los iguales (rango medio)
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    let eq = lo; while (eq < n && sorted[eq] === v) eq++;
    const pct = (lo + (eq - lo) / 2) / n;
    const q = Math.min(5, Math.floor(pct * 5) + 1);
    return higherIsBetter ? q : 6 - q;
  };
}

export function computeRfm(profiles: readonly PlayerProfile[], now: Date): Map<string, RfmScore> {
  const rows = profiles.filter((p) => p.stats.deposit_count > 0).map((p) => {
    const acts = p.timeline.filter((t) => ACTIVITY.has(t.event_type)).map((t) => Date.parse(t.occurred_at)).filter((t) => t <= now.getTime());
    const last = acts.length ? Math.max(...acts) : Date.parse(p.stats.first_deposit_at ?? p.registered_at ?? now.toISOString());
    return { id: p.player_id, recency: Math.max(0, Math.floor((now.getTime() - last) / DAY)), frequency: p.stats.deposit_count, monetary: Math.max(0, p.stats.deposits_minor) };
  });
  const rS = quintileScorer(rows.map((x) => x.recency), false);
  const fS = quintileScorer(rows.map((x) => x.frequency), true);
  const mS = quintileScorer(rows.map((x) => x.monetary), true);
  const out = new Map<string, RfmScore>();
  for (const x of rows) {
    const r = rS(x.recency), f = fS(x.frequency), m = mS(x.monetary);
    out.set(x.id, { r, f, m, segment: rfmSegment(r, f, m), recency_days: x.recency, frequency: x.frequency, monetary_minor: x.monetary });
  }
  return out;
}

export type Derived = { rfm?: Map<string, RfmScore>; now: Date };

/** Distribución por segmento RFM y por etapa de ciclo de vida, con depósitos netos de cada grupo. */
export function distribution(profiles: readonly PlayerProfile[], now: Date) {
  const rfm = computeRfm(profiles, now);
  const bySeg = new Map<RfmSegment, { players: number; deposits_minor: number }>();
  const byLife = new Map<Lifecycle, { players: number; deposits_minor: number }>();
  for (const p of profiles) {
    const life = lifecycleOf(p, now);
    const l = byLife.get(life) ?? { players: 0, deposits_minor: 0 }; l.players++; l.deposits_minor += p.stats.deposits_minor; byLife.set(life, l);
    const s = rfm.get(p.player_id);
    if (s) { const g = bySeg.get(s.segment) ?? { players: 0, deposits_minor: 0 }; g.players++; g.deposits_minor += p.stats.deposits_minor; bySeg.set(s.segment, g); }
  }
  return {
    as_of: now.toISOString(), depositors: rfm.size, total: profiles.length,
    rfm: (Object.keys(RFM_LABELS) as RfmSegment[]).map((k) => ({ key: k, label: RFM_LABELS[k], ...(bySeg.get(k) ?? { players: 0, deposits_minor: 0 }) })),
    lifecycle: (Object.keys(LIFECYCLE_LABELS) as Lifecycle[]).map((k) => ({ key: k, label: LIFECYCLE_LABELS[k], ...(byLife.get(k) ?? { players: 0, deposits_minor: 0 }) })),
    method: 'Quintiles dentro del tenant entre jugadores con depósito. R: días desde la última apuesta o depósito (menos días, más puntos). F: número de depósitos. M: depósitos netos de reversos.',
  };
}

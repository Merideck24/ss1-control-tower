/**
 * Personas dinámicas (C4): k-means determinista sobre conducta, con nombres legibles
 * a partir de los rasgos que más distinguen a cada grupo e IDs estables entre reentrenamientos.
 */
import type { PlayerFacts } from './performance.ts';
import { DAY } from '../shared/util.ts';

export const PERSONA_FEATURES = ['casino_share', 'avg_stake', 'active_days_30d', 'deposits_30d', 'recency_days', 'bonus_ratio', 'night_share'] as const;
type PF = (typeof PERSONA_FEATURES)[number];
const TRAIT: Record<PF, [string, string]> = {
  casino_share: ['más casino', 'más deportes'], avg_stake: ['apuesta alta', 'apuesta baja'], active_days_30d: ['muy activo', 'poco activo'],
  deposits_30d: ['deposita seguido', 'deposita poco'], recency_days: ['ausente', 'reciente'], bonus_ratio: ['dependiente de bonos', 'sin bonos'], night_share: ['nocturno', 'diurno'],
};
const HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Bogota', hour: 'numeric', hourCycle: 'h23' });

export function personaVector(f: Readonly<PlayerFacts>, now: number): number[] | null {
  const bets = f.bets.filter((b) => b.at <= now);
  const deps = [...f.deposits.values()].filter((d) => d.at <= now);
  if (!bets.length && !deps.length) return null;
  const stake = bets.reduce((s, b) => s + b.stake, 0);
  const acts = [...bets.map((b) => b.at), ...deps.map((d) => d.at)];
  const in30 = (a: number) => a > now - 30 * DAY;
  const night = bets.filter((b) => { const h = Number(HOUR.format(b.at)) % 24; return h >= 22 || h < 6; }).length;
  return [
    stake ? bets.filter((b) => b.product === 'casino').reduce((s, b) => s + b.stake, 0) / stake : 0.5,
    bets.length ? Math.log1p(stake / bets.length / 100) : 0,
    new Set(acts.filter(in30).map((a) => Math.floor(a / DAY))).size,
    deps.filter((d) => in30(d.at)).length,
    Math.min(120, (now - Math.max(...acts)) / DAY),
    deps.length ? Math.min(3, f.bonuses.filter((b) => b.at <= now).length / deps.length) : 0,
    bets.length ? night / bets.length : 0,
  ];
}

function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export type Persona = { id: string; name: string; size: number; traits: string[]; centroid: Record<PF, number> };
export type PersonaModel = { k: number; personas: Persona[]; assignment: Map<string, string>; inertia: number };

export function trainPersonas(facts: readonly Readonly<PlayerFacts>[], now: Date, k = 5, seed = 42): PersonaModel {
  const T = now.getTime();
  const rows = facts.flatMap((f) => { const v = personaVector(f, T); return v ? [{ id: f.player_id, v }] : []; });
  const empty: PersonaModel = { k: 0, personas: [], assignment: new Map(), inertia: 0 };
  if (rows.length < k * 3) return empty;
  const d = PERSONA_FEATURES.length;
  const mean = Array.from({ length: d }, (_, j) => rows.reduce((s, r) => s + r.v[j], 0) / rows.length);
  const std = Array.from({ length: d }, (_, j) => Math.sqrt(rows.reduce((s, r) => s + (r.v[j] - mean[j]) ** 2, 0) / rows.length) || 1);
  const Z = rows.map((r) => r.v.map((x, j) => (x - mean[j]) / std[j]));
  const dist = (a: number[], b: number[]) => a.reduce((s, x, j) => s + (x - b[j]) ** 2, 0);
  // k-means++ determinista
  const r = rng(seed);
  const C: number[][] = [Z[Math.floor(r() * Z.length)]];
  while (C.length < k) {
    const ds = Z.map((z) => Math.min(...C.map((c) => dist(z, c))));
    const tot = ds.reduce((s, x) => s + x, 0);
    let u = r() * tot, i = 0;
    while (u > ds[i] && i < ds.length - 1) { u -= ds[i]; i++; }
    C.push(Z[i]);
  }
  let assign = new Array(Z.length).fill(0);
  for (let it = 0; it < 50; it++) {
    const next = Z.map((z) => { let best = 0, bd = Infinity; C.forEach((c, j) => { const dd = dist(z, c); if (dd < bd) { bd = dd; best = j; } }); return best; });
    const changed = next.some((a, i) => a !== assign[i]);
    assign = next;
    for (let j = 0; j < k; j++) { const m = Z.filter((_z, i) => assign[i] === j); if (m.length) C[j] = Array.from({ length: d }, (_, q) => m.reduce((s, z) => s + z[q], 0) / m.length); }
    if (!changed && it > 0) break;
  }
  const inertia = Z.reduce((s, z, i) => s + dist(z, C[assign[i]]), 0);
  // IDs estables: orden por actividad + depósitos del centroide (descendente)
  const order = C.map((c, j) => ({ j, key: c[2] + c[3] - c[4] })).sort((a, b) => b.key - a.key).map((x) => x.j);
  const personas: Persona[] = order.map((j, rank) => {
    const c = C[j];
    const traits = PERSONA_FEATURES.map((f, q) => ({ f, z: c[q] })).filter((t) => Math.abs(t.z) >= 0.35).sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 3).map((t) => TRAIT[t.f][t.z >= 0 ? 0 : 1]);
    const name = traits.length ? traits.slice(0, 2).map((t, i) => (i === 0 ? t[0].toUpperCase() + t.slice(1) : t)).join(', ') : 'Perfil promedio';
    return { id: `P${rank + 1}`, name, size: assign.filter((a) => a === j).length, traits, centroid: Object.fromEntries(PERSONA_FEATURES.map((f, q) => [f, +(c[q] * std[q] + mean[q]).toFixed(2)])) as Record<PF, number> };
  });
  const idOf = new Map(order.map((j, rank) => [j, `P${rank + 1}`]));
  return { k, personas, assignment: new Map(rows.map((row, i) => [row.id, idOf.get(assign[i])!])), inertia };
}

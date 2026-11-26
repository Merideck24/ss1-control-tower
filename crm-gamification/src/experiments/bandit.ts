import type { EventEnvelope, EventType } from '../domain/events.ts';
import { sha256, stableBucket } from '../shared/util.ts';

/**
 * D5 · A/B/n dentro de recorridos y optimización automática (Thompson sampling).
 * - «fixed»: reparto por pesos, estable por jugador (hash).
 * - «bandit»: tras un calentamiento por variante, el reparto sigue la probabilidad
 *   posterior de ser la mejor (Beta-Binomial), con un piso de exploración por variante.
 * Todo es determinista y auditable: cada asignación guarda el reparto vigente.
 */
export type SplitVariant = { id: string; label: string; weight: number; next: string };
export type SplitNode = {
  id: string; type: 'split'; mode: 'fixed' | 'bandit';
  metric: { event: EventType; window_hours: number };
  variants: SplitVariant[];
  min_explore_pct?: number; // piso por variante en modo bandit (por defecto 10 %)
  warmup_per_variant?: number; // resultados cerrados por variante antes de optimizar (por defecto 30)
};

export type Assignment = { player_id: string; variant: string; at: number; converted_at?: number; allocation: Record<string, number> };
export type VariantStats = { id: string; label: string; assigned: number; decided: number; conversions: number; rate: number | null; ci95: [number, number] | null; p_best: number | null; allocation: number };

const HOUR = 3_600_000;

/** RNG determinista (mulberry32) sembrado por texto. */
function rngFrom(seed: string) {
  let a = parseInt(sha256(seed).slice(0, 8), 16) >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function normal(r: () => number) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
/** Gamma(k, 1) por Marsaglia–Tsang (k ≥ 1 aquí: los parámetros Beta empiezan en 1). */
function gamma(k: number, r: () => number): number {
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { x = normal(r); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = r();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
const beta = (a: number, b: number, r: () => number) => { const x = gamma(a, r); return x / (x + gamma(b, r)); };

/** Probabilidad de que cada variante sea la mejor (Monte Carlo sembrado, reproducible). */
export function probabilityBest(stats: { id: string; decided: number; conversions: number }[], seed: string, draws = 4000): Record<string, number> {
  const r = rngFrom(seed);
  const wins: Record<string, number> = Object.fromEntries(stats.map((s) => [s.id, 0]));
  for (let i = 0; i < draws; i++) {
    let best = '', bv = -1;
    for (const s of stats) { const v = beta(1 + s.conversions, 1 + s.decided - s.conversions, r); if (v > bv) { bv = v; best = s.id; } }
    wins[best]++;
  }
  return Object.fromEntries(stats.map((s) => [s.id, wins[s.id] / draws]));
}

/** Intervalo de Wilson al 95 %. */
export function wilson(k: number, n: number): [number, number] | null {
  if (!n) return null;
  const z = 1.96, p = k / n, den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export class SplitTracker {
  #byKey = new Map<string, Assignment[]>(); // tenant::journey::node
  #byPlayer = new Map<string, { key: string; a: Assignment; metric: SplitNode['metric'] }[]>();
  #allocCache = new Map<string, { at: number; size: number; sig: string; alloc: Record<string, number> }>();
  #assigned = new Map<string, Map<string, Assignment>>(); // key → jugador → asignación (búsqueda O(1))

  static key(tenant: string, journey: string, node: string) { return `${tenant}::${journey}::${node}`; }
  assignments(key: string) { return this.#byKey.get(key) ?? []; }

  /** Reparto vigente: pesos fijos, o bandit tras el calentamiento. */
  allocation(key: string, node: SplitNode, now: number): { alloc: Record<string, number>; phase: 'fixed' | 'warmup' | 'optimizing' } {
    const ws = node.variants.map((v) => Math.max(0, Number(v.weight) || 0));
    const tot = ws.reduce((s, w) => s + w, 0);
    const fixed = Object.fromEntries(node.variants.map((v, i) => [v.id, tot > 0 ? ws[i] / tot : 1 / node.variants.length]));
    if (node.mode === 'fixed') return { alloc: fixed, phase: 'fixed' };
    // con reparto vigente en caché no hace falta recalcular estadísticas (O(n) por asignación)
    // la caché vale solo para las mismas variantes y el mismo calentamiento: una versión nueva que agrega
    // una variante o sube el calentamiento vuelve a pasar por la fase de calentamiento
    const sig = `${node.variants.map((v) => v.id).join('|')}#${node.warmup_per_variant ?? 30}#${node.min_explore_pct ?? 10}`;
    const size0 = this.assignments(key).length;
    const hit0 = this.#allocCache.get(key);
    if (hit0 && hit0.sig === sig && now - hit0.at < 24 * HOUR && size0 - hit0.size < 50) return { alloc: hit0.alloc, phase: 'optimizing' };
    const st = this.stats(key, node, now, false);
    const warm = node.warmup_per_variant ?? 30;
    if (st.some((s) => s.decided < warm)) return { alloc: fixed, phase: 'warmup' };
    // se recalcula cada 50 asignaciones nuevas o, sin volumen, una vez al día
    const size = this.assignments(key).length;
    const hit = this.#allocCache.get(key);
    if (hit && hit.sig === sig && now - hit.at < 24 * HOUR && size - hit.size < 50) return { alloc: hit.alloc, phase: 'optimizing' };
    const pb = probabilityBest(st, `${key}:${size}`, 1500); // reparto: precisión suficiente; el informe usa 4.000
    const floor = Math.min(1 / node.variants.length, (node.min_explore_pct ?? 10) / 100);
    const free = 1 - floor * node.variants.length;
    const alloc = Object.fromEntries(node.variants.map((v) => [v.id, floor + free * pb[v.id]]));
    this.#allocCache.set(key, { at: now, size, sig, alloc });
    return { alloc, phase: 'optimizing' };
  }

  /** Asignación estable: un jugador ve siempre la misma variante de un mismo split. */
  assign(tenant: string, journey: string, node: SplitNode, player: string, now: number): Assignment {
    const key = SplitTracker.key(tenant, journey, node.id);
    const prior = this.#assigned.get(key)?.get(player);
    if (prior) return prior;
    const { alloc } = this.allocation(key, node, now);
    const u = stableBucket(`${key}::${player}`);
    let acc = 0, variant = node.variants.at(-1)!.id;
    for (const v of node.variants) { acc += alloc[v.id] ?? 0; if (u < acc) { variant = v.id; break; } }
    const a: Assignment = { player_id: player, variant, at: now, allocation: alloc };
    const list = this.#byKey.get(key); if (list) list.push(a); else this.#byKey.set(key, [a]);
    const idx = this.#assigned.get(key); if (idx) idx.set(player, a); else this.#assigned.set(key, new Map([[player, a]]));
    const pk = `${tenant}::${player}`;
    const mine = this.#byPlayer.get(pk); const entry = { key, a, metric: node.metric };
    if (mine) mine.push(entry); else this.#byPlayer.set(pk, [entry]);
    return a;
  }

  /** Conversión: primer evento de la métrica dentro de la ventana posterior a la asignación. */
  onEvent(e: EventEnvelope) {
    const t = Date.parse(e.occurred_at);
    for (const x of this.#byPlayer.get(`${e.tenant_id}::${e.player_id}`) ?? []) {
      if (x.a.converted_at !== undefined || x.metric.event !== e.event_type) continue;
      if (t >= x.a.at && t <= x.a.at + x.metric.window_hours * HOUR) x.a.converted_at = t;
    }
  }

  /** Resultados por variante. «decided» = convirtió o ya cerró su ventana (sin sesgo por casos abiertos). */
  stats(key: string, node: SplitNode, now: number, withPBest = true): VariantStats[] {
    const as = this.assignments(key);
    const win = node.metric.window_hours * HOUR;
    const base = node.variants.map((v) => {
      const mine = as.filter((a) => a.variant === v.id);
      const decided = mine.filter((a) => a.converted_at !== undefined || a.at + win <= now);
      const conv = decided.filter((a) => a.converted_at !== undefined).length;
      return { id: v.id, label: v.label, assigned: mine.length, decided: decided.length, conversions: conv };
    });
    const pb = withPBest && base.some((b) => b.decided > 0) ? probabilityBest(base, `${key}:report:${Math.floor(now / HOUR)}`) : null;
    const alloc = withPBest ? this.allocation(key, node, now).alloc : {};
    return base.map((b) => ({ ...b, rate: b.decided ? b.conversions / b.decided : null, ci95: wilson(b.conversions, b.decided), p_best: pb ? pb[b.id] : null, allocation: alloc[b.id] ?? 0 }));
  }
}

/**
 * Canal de tiempo real por jugador (progreso, recompensas, logros).
 *
 * - Cada evento lleva un `id` creciente por tenant y jugador. El cliente guarda el último que vio y,
 *   al reconectar, pide los posteriores (`since`): no se pierden ni se duplican avisos.
 * - Se guardan los últimos 200 por jugador. Si el cliente pide desde un id que ya salió del búfer,
 *   la respuesta trae `resync: true` y el cliente vuelve a leer el estado completo.
 * - Aislamiento: la llave es tenant::jugador; un suscriptor solo recibe lo de su propia llave.
 * - Transporte: SSE en el servidor (`GET /api/players/:id/stream`) y sondeo con el mismo cursor
 *   (`GET /players/:id/realtime?after=`) en la demo estática o como respaldo.
 */
export type RealtimeType = 'challenge.progress' | 'challenge.step_done' | 'challenge.completed' | 'reward.status' | 'achievement.unlocked' | 'challenge.suspended' | 'gift.received' | 'gift.held' | 'gift.revoked' | 'leaderboard.updated' | 'tournament.result' | 'contest.result';
export type RealtimeEvent = { id: number; at: string; type: RealtimeType; data: Record<string, unknown> };

const KEEP = 200;

export class RealtimeHub {
  #seq = new Map<string, number>();
  #buf = new Map<string, RealtimeEvent[]>();
  #subs = new Map<string, Set<(e: RealtimeEvent) => void>>();
  #now: () => Date;
  constructor(now: () => Date) { this.#now = now; }

  publish(tenant: string, player: string, type: RealtimeType, data: Record<string, unknown>): RealtimeEvent {
    const k = `${tenant}::${player}`;
    const id = (this.#seq.get(k) ?? 0) + 1;
    this.#seq.set(k, id);
    const e: RealtimeEvent = { id, at: this.#now().toISOString(), type, data };
    const b = this.#buf.get(k) ?? [];
    b.push(e);
    if (b.length > KEEP) b.splice(0, b.length - KEEP);
    this.#buf.set(k, b);
    for (const fn of this.#subs.get(k) ?? []) { try { fn(e); } catch { /* un suscriptor caído no frena a los demás */ } }
    return e;
  }

  /** Eventos posteriores a `after`. `resync` si se perdió parte del historial (búfer superado). */
  since(tenant: string, player: string, after = 0): { last: number; events: RealtimeEvent[]; resync: boolean } {
    const k = `${tenant}::${player}`;
    const b = this.#buf.get(k) ?? [];
    const last = this.#seq.get(k) ?? 0;
    const oldest = b[0]?.id ?? last + 1;
    const resync = after > 0 && after + 1 < oldest;
    return { last, events: b.filter((e) => e.id > after), resync };
  }

  subscribe(tenant: string, player: string, fn: (e: RealtimeEvent) => void): () => void {
    const k = `${tenant}::${player}`;
    const s = this.#subs.get(k) ?? new Set();
    s.add(fn); this.#subs.set(k, s);
    return () => { s.delete(fn); };
  }
}

/**
 * Tablas de clasificación: por torneo, por reto y por temporada de fidelidad.
 *
 * - Orden y desempate visibles: mayor puntaje; a igual puntaje, quien llegó antes; luego un orden estable.
 *   Cada fila dice si está empatada en puntaje con otra y por qué quedó en ese lugar.
 * - Privacidad: se muestra el alias solo si el jugador lo autorizó; si no, un nombre opaco y estable
 *   («Jugador ·a1b2») que no revela el id. El jugador puede ocultarse: sigue contando, pero aparece como
 *   «Jugador oculto». Nunca se muestran saldos, depósitos ni montos apostados.
 * - Juego responsable: quien tiene restricción, caso abierto o señal reciente no aparece.
 * - Visibilidad por tabla: pública, solo participantes, u oculta (solo backoffice).
 * - Paginación con tamaño acotado y la fila propia aparte, aunque esté fuera de la página.
 */
import type { LoyaltyService } from '../loyalty/loyalty.ts';
import type { PlayerProfile } from '../profile/projection.ts';
import { DomainError, sha256 } from '../shared/util.ts';
import type { AchievementService } from './achievements.ts';
import type { ChallengeService } from './challenges.ts';
import type { GamesService } from './games.ts';
import { rgIneligibility } from './safeguards.ts';

export type BoardType = 'tournament' | 'challenge' | 'season';
export type BoardRow = { position: number; display: string; avatar: { initial: string; hue: number }; score: number; tied: boolean; reached_at: string; is_viewer: boolean; player_id?: string };
type Deps = { games: GamesService; challenges: ChallengeService; loyalty: LoyaltyService; achievements: AchievementService; profile: (t: string, p: string) => PlayerProfile | undefined; now: () => string; riskHold?: (t: string, p: string) => boolean };
export const MAX_PAGE = 50;

export class LeaderboardService {
  #d: Deps;
  #hidden = new Set<string>(); // tenant::player
  onChange?: (x: { tenant_id: string; player_id: string; hidden: boolean }) => void;
  constructor(d: Deps) { this.#d = d; }

  setHidden(tenant: string, player: string, hidden: boolean) {
    const k = `${tenant}::${player}`; hidden ? this.#hidden.add(k) : this.#hidden.delete(k);
    this.onChange?.({ tenant_id: tenant, player_id: player, hidden });
    return { hidden };
  }
  isHidden(tenant: string, player: string) { return this.#hidden.has(`${tenant}::${player}`); }
  restore(rows: { tenant_id: string; player_id: string; hidden: boolean }[]) { for (const r of rows) r.hidden ? this.#hidden.add(`${r.tenant_id}::${r.player_id}`) : this.#hidden.delete(`${r.tenant_id}::${r.player_id}`); }

  /** Nombre público: alias autorizado, «Jugador oculto» o un nombre opaco estable. */
  display(tenant: string, player: string) {
    const h = sha256(`${tenant}:${player}:board`);
    const hue = parseInt(h.slice(0, 4), 16) % 360;
    if (this.isHidden(tenant, player)) return { display: 'Jugador oculto', avatar: { initial: '·', hue: 0 } };
    const al = this.#d.achievements.alias(tenant, player);
    if (al?.show_on_cards) return { display: al.alias, avatar: { initial: al.alias[0].toUpperCase(), hue } };
    return { display: `Jugador ·${h.slice(0, 4)}`, avatar: { initial: 'J', hue } };
  }

  #raw(tenant: string, type: BoardType, id: string): { name: string; visibility: 'public' | 'participants' | 'hidden'; participants: Set<string>; rows: { player_id: string; score: number; reached_at: string }[]; tie_rule: string } {
    if (type === 'tournament') {
      const t = this.#d.games.tournament(tenant, id);
      if (!t || t.status === 'draft' || t.status === 'pending_approval') throw new DomainError('not_found', 'Torneo inexistente o sin iniciar.');
      return { name: t.name, visibility: t.leaderboard_visibility ?? 'public', participants: new Set(this.#d.games.participants(tenant, id)),
        rows: this.#d.games.standings(tenant, id).map((s) => ({ player_id: s.player_id, score: s.score, reached_at: s.reached_at })), tie_rule: 'A igual puntaje, queda arriba quien lo alcanzó primero.' };
    }
    if (type === 'challenge') {
      const c = this.#d.challenges.get(tenant, id);
      if (!c || c.status === 'draft' || c.status === 'pending_approval') throw new DomainError('not_found', 'Reto inexistente o sin aprobar.');
      const ens = this.#d.challenges.enrollments(tenant, id).filter((e) => e.status === 'active');
      const rows = ens.map((e) => {
        // período más reciente con avance: pasos cumplidos (tope en la meta) y cuándo se completó
        const per = Object.values(e.periods).at(-1);
        const score = per ? c.steps.reduce((s, st) => s + Math.min(per.steps[st.id] ?? 0, st.target), 0) : 0;
        return { player_id: e.player_id, score, reached_at: per?.completed_at ?? e.enrolled_at };
      }).filter((r) => r.score > 0);
      return { name: c.name, visibility: 'participants', participants: new Set(ens.map((e) => e.player_id)), rows, tie_rule: 'A igual avance, queda arriba quien completó (o se inscribió) primero.' };
    }
    const p = this.#d.loyalty;
    const rows = p.seasonTotals(tenant, id).filter((r) => r.points > 0).map((r) => ({ player_id: r.player_id, score: r.points, reached_at: r.at }));
    return { name: `Temporada ${id}`, visibility: 'public', participants: new Set(rows.map((r) => r.player_id)), rows, tie_rule: 'A igual XP, queda arriba quien llegó primero a ese total.' };
  }

  /**
   * Una página de la clasificación. `viewer`: jugador que mira (sitio); sin viewer = backoffice (ve ids).
   */
  board(tenant: string, type: BoardType, id: string, o: { page?: number; size?: number; viewer?: string } = {}) {
    const raw = this.#raw(tenant, type, id);
    if (o.viewer !== undefined) {
      if (raw.visibility === 'hidden') throw new DomainError('not_visible', 'Esta clasificación no se muestra en el sitio.');
      if (raw.visibility === 'participants' && !raw.participants.has(o.viewer)) throw new DomainError('not_participant', 'La clasificación es solo para participantes.');
    }
    const now = this.#d.now();
    const ok = raw.rows.filter((r) => { const p = this.#d.profile(tenant, r.player_id); return p && !rgIneligibility({ loyalty: this.#d.loyalty, riskHold: this.#d.riskHold }, p, now).length; })
      .sort((a, b) => b.score - a.score || a.reached_at.localeCompare(b.reached_at) || a.player_id.localeCompare(b.player_id));
    const count = new Map<number, number>(); for (const r of ok) count.set(r.score, (count.get(r.score) ?? 0) + 1);
    const all: BoardRow[] = ok.map((r, i) => ({ position: i + 1, ...this.display(tenant, r.player_id), score: r.score, tied: (count.get(r.score) ?? 0) > 1, reached_at: r.reached_at, is_viewer: r.player_id === o.viewer, ...(o.viewer === undefined ? { player_id: r.player_id } : {}) }));
    const size = Math.min(MAX_PAGE, Math.max(1, Math.floor(o.size ?? 10)));
    const pages = Math.max(1, Math.ceil(all.length / size));
    const page = Math.min(pages, Math.max(1, Math.floor(o.page ?? 1)));
    return { type, id, name: raw.name, visibility: raw.visibility, as_of: now, total: all.length, page, size, pages, tie_rule: raw.tie_rule,
      rows: all.slice((page - 1) * size, page * size), viewer_row: o.viewer ? all.find((r) => r.is_viewer) ?? null : null, viewer_hidden: o.viewer ? this.isHidden(tenant, o.viewer) : undefined };
  }

  /** Tablas disponibles para un jugador, con su posición en cada una. */
  forPlayer(tenant: string, player: string, season: string | undefined) {
    const out: { type: BoardType; id: string; name: string; position: number | null; total: number }[] = [];
    const add = (type: BoardType, id: string) => { try { const b = this.board(tenant, type, id, { viewer: player, size: 1 }); out.push({ type, id, name: b.name, position: b.viewer_row?.position ?? null, total: b.total }); } catch { /* no visible para este jugador */ } };
    for (const t of this.#d.games.tournaments(tenant)) if (t.status === 'active' || t.status === 'results_pending' || t.status === 'finished') add('tournament', t.id);
    for (const c of this.#d.challenges.list(tenant)) if (c.status === 'active') add('challenge', c.id);
    if (season) add('season', season);
    return out;
  }
}

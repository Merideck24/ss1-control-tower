/**
 * Torneos (G4) y mini-juegos (G5).
 * Torneos: ranking reproducible desde los eventos (desempate: quien alcanzó su puntaje antes, luego id),
 * foto final con hash, premios idempotentes. Mini-juegos: tiradas gratuitas, tabla de premios explícita y
 * azar auditable por compromiso-revelación (sha256 de la semilla publicado; la semilla se revela al rotar).
 * Exclusiones: gamificación desactivada y restricción de juego responsable.
 */
import type { AuditLog } from '../audit/audit.ts';
import type { EventEnvelope } from '../domain/events.ts';
import type { LoyaltyService } from '../loyalty/loyalty.ts';
import type { PolicyEngine } from '../policy/policyEngine.ts';
import type { PlayerProfile } from '../profile/projection.ts';
import type { RewardService } from '../rewards/rewards.ts';
import { DomainError, sha256, uuid, type Clock } from '../shared/util.ts';

type Deps = { clock: Clock; audit: AuditLog; loyalty: LoyaltyService; rewards: RewardService; policy: PolicyEngine; profile: (t: string, p: string) => PlayerProfile | undefined };
type Prize = { xp?: number; reward_id?: string };
const excluded = (d: Deps, p: PlayerProfile | undefined) => !p || d.loyalty.isOptedOut(p.tenant_id, p.player_id) || (!!p.rg && p.rg.value !== 'none');

// ---------------- Torneos ----------------
export type Tournament = {
  id: string; tenant_id: string; brand_id: string; name: string;
  metric: 'bet_count' | 'stake_capped'; stake_cap_minor?: number; product?: 'casino' | 'sports';
  starts_at: string; ends_at: string; min_score: number;
  prizes: { from: number; to: number; prize: Prize }[];
  status: 'draft' | 'pending_approval' | 'active' | 'finished'; created_by: string; approved_by?: string;
  final?: { at: string; hash: string; standings: Standing[]; excluded: number; payouts: { player_id: string; rank: number; status: string }[] };
};
export type ScoreEvent = { player_id: string; event_id: string; at: string; points: number };
export type Standing = { rank: number; player_id: string; score: number; reached_at: string };

/** Ranking puro y determinista: mismo conjunto de eventos ⇒ mismo resultado, en cualquier orden. */
export function rankTournament(events: readonly ScoreEvent[], minScore = 0): Standing[] {
  const seen = new Set<string>();
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at) || a.event_id.localeCompare(b.event_id));
  const acc = new Map<string, { score: number; reached_at: string }>();
  for (const e of sorted) {
    if (seen.has(e.event_id)) continue; seen.add(e.event_id);
    const a = acc.get(e.player_id) ?? { score: 0, reached_at: e.at };
    a.score += e.points; a.reached_at = e.at; acc.set(e.player_id, a);
  }
  return [...acc].filter(([, a]) => a.score >= minScore && a.score > 0)
    .sort((x, y) => y[1].score - x[1].score || x[1].reached_at.localeCompare(y[1].reached_at) || x[0].localeCompare(y[0]))
    .map(([player_id, a], i) => ({ rank: i + 1, player_id, score: a.score, reached_at: a.reached_at }));
}
export const standingsHash = (s: readonly Standing[]) => sha256(JSON.stringify(s.map((x) => [x.rank, x.player_id, x.score, x.reached_at])));

// ---------------- Mini-juegos ----------------
export type MiniGame = {
  id: string; tenant_id: string; brand_id: string; name: string; kind: 'wheel' | 'box';
  spins_per_day: number; prizes: { id: string; label: string; weight: number; prize: Prize }[];
  status: 'active' | 'paused'; created_by: string;
};
type Seed = { seed: string; commit: string; from: string; revealed_at?: string };
export type Spin = { request_id: string; player_id: string; game_id: string; nonce: number; commit: string; outcome: string; label: string; at: string; reward_status: string };

/** Resultado verificable: u = primeros 52 bits de sha256(seed:player:nonce) / 2^52 → premio por pesos acumulados. */
export function outcomeFor(seed: string, player: string, nonce: number, prizes: MiniGame['prizes']): MiniGame['prizes'][number] {
  const h = sha256(`${seed}:${player}:${nonce}`);
  const u = parseInt(h.slice(0, 13), 16) / 2 ** 52;
  const total = prizes.reduce((s, p) => s + p.weight, 0);
  let acc = 0;
  for (const p of prizes) { acc += p.weight / total; if (u < acc) return p; }
  return prizes[prizes.length - 1];
}

const DAYF = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' });

export class GamesService {
  #d: Deps;
  #tournaments = new Map<string, Tournament>();
  #scores = new Map<string, ScoreEvent[]>(); // tenant::tournament
  #games = new Map<string, MiniGame>();
  #seeds = new Map<string, Seed[]>(); // tenant::game → historial (último = vigente)
  #spins = new Map<string, Spin>(); // request_id
  #nonces = new Map<string, number>(); // tenant::game::player
  constructor(d: Deps) { this.#d = d; }

  // ---- torneos ----
  saveTournament(actor: { id: string; tenant_id: string }, t: Omit<Tournament, 'tenant_id' | 'status' | 'created_by' | 'approved_by' | 'final'>): Tournament {
    if (!/^[\w-]{3,48}$/.test(t.id)) throw new DomainError('invalid_tournament', 'id inválido');
    if (!t.prizes.length || t.prizes.some((p) => p.from < 1 || p.to < p.from || (!p.prize.xp && !p.prize.reward_id))) throw new DomainError('invalid_tournament', 'premios inválidos');
    if (t.metric === 'stake_capped' && !(t.stake_cap_minor! > 0)) throw new DomainError('invalid_tournament', 'stake_capped requiere stake_cap_minor');
    if (Date.parse(t.ends_at) <= Date.parse(t.starts_at)) throw new DomainError('invalid_tournament', 'ventana inválida');
    const k = `${actor.tenant_id}::${t.id}`;
    if (this.#tournaments.get(k) && this.#tournaments.get(k)!.status !== 'draft') throw new DomainError('invalid_state', 'solo borradores');
    const out: Tournament = { ...structuredClone(t), tenant_id: actor.tenant_id, status: 'draft', created_by: actor.id };
    this.#tournaments.set(k, out);
    this.#d.audit.record(actor.tenant_id, actor.id, 'tournament.draft_saved', t.id, { metric: t.metric });
    return out;
  }
  activateTournament(actor: { id: string; tenant_id: string; canApprove: boolean }, id: string): Tournament {
    const t = this.tournament(actor.tenant_id, id);
    if (!t) throw new DomainError('not_found', id);
    const costly = t.prizes.some((p) => p.prize.reward_id);
    if (costly && t.status === 'draft') { t.status = 'pending_approval'; return t; }
    if (costly) {
      if (t.status !== 'pending_approval') throw new DomainError('invalid_state', t.status);
      if (!actor.canApprove) throw new DomainError('forbidden', 'requiere aprobador');
      if (t.created_by === actor.id) throw new DomainError('segregation_of_duties', 'el autor no puede aprobar su torneo');
      t.approved_by = actor.id;
    } else if (t.status !== 'draft') throw new DomainError('invalid_state', t.status);
    t.status = 'active';
    this.#d.audit.record(t.tenant_id, actor.id, 'tournament.activated', id, {});
    return t;
  }
  tournament(tenant: string, id: string) { return this.#tournaments.get(`${tenant}::${id}`); }
  tournaments(tenant: string) { return [...this.#tournaments.values()].filter((t) => t.tenant_id === tenant); }
  standings(tenant: string, id: string) { const t = this.tournament(tenant, id); return t?.final?.standings ?? (t ? rankTournament(this.#scores.get(`${tenant}::${id}`) ?? [], t.min_score) : []); }

  onEvent(e: EventEnvelope, p: PlayerProfile | undefined) {
    if (e.event_type !== 'bet.settled' || excluded(this.#d, p)) return;
    const pl = (e as EventEnvelope<'bet.settled'>).payload;
    for (const t of this.tournaments(e.tenant_id)) {
      if (t.status !== 'active' || t.brand_id !== e.brand_id || e.occurred_at < t.starts_at || e.occurred_at > t.ends_at) continue;
      if (t.product && pl.product !== t.product) continue;
      const stake = pl.stake.amount_minor;
      if (stake === 0) continue; // un premio no es una apuesta
      // una reversión (stake negativo) descuenta lo que había sumado la apuesta
      const points = (stake > 0 ? 1 : -1) * (t.metric === 'bet_count' ? 1 : Math.min(Math.abs(stake), t.stake_cap_minor!));
      const k = `${e.tenant_id}::${t.id}`;
      const arr = this.#scores.get(k) ?? []; arr.push({ player_id: e.player_id, event_id: e.event_id, at: e.occurred_at, points }); this.#scores.set(k, arr);
    }
  }

  /** Cierre: foto con hash, exclusiones al momento del cierre y premios idempotentes. */
  finalizeTournament(actor: { id: string; tenant_id: string }, id: string): Tournament {
    const t = this.tournament(actor.tenant_id, id);
    if (!t) throw new DomainError('not_found', id);
    if (t.status === 'finished') return t; // idempotente
    if (t.status !== 'active') throw new DomainError('invalid_state', t.status);
    if (this.#d.clock.now().toISOString() < t.ends_at) throw new DomainError('not_ended', 'el torneo aún no termina');
    const raw = rankTournament(this.#scores.get(`${t.tenant_id}::${id}`) ?? [], t.min_score);
    const eligible = raw.filter((s) => !excluded(this.#d, this.#d.profile(t.tenant_id, s.player_id))).map((s, i) => ({ ...s, rank: i + 1 }));
    const payouts: { player_id: string; rank: number; status: string }[] = [];
    for (const s of eligible) {
      const tier = t.prizes.find((p) => s.rank >= p.from && s.rank <= p.to);
      if (!tier) continue;
      const p = this.#d.profile(t.tenant_id, s.player_id)!;
      const ref = `tournament:${id}:${s.player_id}`;
      let status = 'xp_awarded';
      if (tier.prize.xp) this.#d.loyalty.award(t.tenant_id, p.brand_id, s.player_id, tier.prize.xp, `tournament:${id}`, ref);
      if (tier.prize.reward_id) {
        const dec = this.#d.policy.decide({ profile: p, purpose: 'marketing', incentive: true });
        status = dec.kind === 'allow' ? this.#d.rewards.grant({ tenant_id: t.tenant_id, player_id: s.player_id, reward_id: tier.prize.reward_id, idempotency_key: ref, actor: `tournament:${id}` }).status : `suppressed:${dec.reasons.join(',')}`;
      }
      payouts.push({ player_id: s.player_id, rank: s.rank, status });
    }
    t.final = { at: this.#d.clock.now().toISOString(), hash: standingsHash(eligible), standings: eligible, excluded: raw.length - eligible.length, payouts };
    t.status = 'finished';
    this.#d.audit.record(t.tenant_id, actor.id, 'tournament.finalized', id, { hash: t.final.hash, payouts: payouts.length, excluded: t.final.excluded });
    return t;
  }

  // ---- mini-juegos ----
  saveGame(actor: { id: string; tenant_id: string }, g: Omit<MiniGame, 'tenant_id' | 'created_by' | 'status'>): MiniGame {
    if (!g.prizes.length || g.prizes.some((p) => !(p.weight > 0))) throw new DomainError('invalid_game', 'pesos inválidos');
    if (!g.prizes.some((p) => !p.prize.xp && !p.prize.reward_id)) throw new DomainError('invalid_game', 'incluye una opción sin premio para controlar el costo');
    for (const p of g.prizes) if (p.prize.reward_id && !this.#d.rewards.item(actor.tenant_id, p.prize.reward_id)) throw new DomainError('invalid_game', `bono ${p.prize.reward_id} no existe`);
    const out: MiniGame = { ...structuredClone(g), tenant_id: actor.tenant_id, status: 'active', created_by: actor.id };
    this.#games.set(`${actor.tenant_id}::${g.id}`, out);
    this.#rotate(actor.tenant_id, g.id);
    this.#d.audit.record(actor.tenant_id, actor.id, 'minigame.saved', g.id, { prizes: g.prizes.map((p) => [p.id, p.weight]) });
    return out;
  }
  #rotate(tenant: string, id: string) {
    const k = `${tenant}::${id}`;
    const list = this.#seeds.get(k) ?? [];
    const now = this.#d.clock.now().toISOString();
    const cur = list.at(-1); if (cur) cur.revealed_at = now;
    const seed = sha256(uuid() + uuid());
    list.push({ seed, commit: sha256(seed), from: now });
    this.#seeds.set(k, list);
  }
  /** Rota la semilla: revela la anterior para verificación pública y publica el compromiso de la nueva. */
  rotateSeed(actor: { id: string; tenant_id: string }, id: string) {
    if (!this.game(actor.tenant_id, id)) throw new DomainError('not_found', id);
    this.#rotate(actor.tenant_id, id);
    this.#d.audit.record(actor.tenant_id, actor.id, 'minigame.seed_rotated', id, {});
    return this.seeds(actor.tenant_id, id);
  }
  seeds(tenant: string, id: string) { return (this.#seeds.get(`${tenant}::${id}`) ?? []).map((s) => ({ commit: s.commit, from: s.from, revealed_at: s.revealed_at ?? null, seed: s.revealed_at ? s.seed : null })); }
  game(tenant: string, id: string) { return this.#games.get(`${tenant}::${id}`); }
  games(tenant: string) { return [...this.#games.values()].filter((g) => g.tenant_id === tenant); }

  spinsLeft(tenant: string, id: string, player: string): number {
    const g = this.game(tenant, id); if (!g) return 0;
    const today = DAYF.format(this.#d.clock.now());
    const used = [...this.#spins.values()].filter((s) => s.game_id === id && s.player_id === player && DAYF.format(new Date(s.at)) === today && this.#spinTenant(s) === tenant).length;
    return Math.max(0, g.spins_per_day - used);
  }
  #spinTenant(s: Spin) { return s.request_id.split('|')[0]; }

  spin(tenant: string, id: string, player: string, requestId: string): Spin {
    const key = `${tenant}|${requestId}`;
    const prev = this.#spins.get(key); if (prev) return prev; // idempotente por solicitud
    const g = this.game(tenant, id); const p = this.#d.profile(tenant, player);
    if (!g || g.status !== 'active') throw new DomainError('not_found', id);
    if (!p || p.brand_id !== g.brand_id) throw new DomainError('not_found', player);
    if (excluded(this.#d, p)) throw new DomainError('not_eligible', 'jugador con gamificación desactivada o restricción de juego responsable');
    if (this.spinsLeft(tenant, id, player) <= 0) throw new DomainError('no_spins', 'sin tiradas disponibles hoy');
    const seed = this.#seeds.get(`${tenant}::${id}`)!.at(-1)!;
    const nk = `${tenant}::${id}::${player}`; const nonce = (this.#nonces.get(nk) ?? 0) + 1; this.#nonces.set(nk, nonce);
    const prize = outcomeFor(seed.seed, player, nonce, g.prizes);
    const ref = `minigame:${id}:${player}:${nonce}:${seed.commit.slice(0, 12)}`;
    let reward_status = 'sin_premio';
    if (prize.prize.xp) { this.#d.loyalty.award(tenant, p.brand_id, player, prize.prize.xp, `minigame:${id}`, ref); reward_status = 'xp_awarded'; }
    if (prize.prize.reward_id) {
      const dec = this.#d.policy.decide({ profile: p, purpose: 'marketing', incentive: true });
      reward_status = dec.kind === 'allow' ? this.#d.rewards.grant({ tenant_id: tenant, player_id: player, reward_id: prize.prize.reward_id, idempotency_key: ref, actor: `minigame:${id}` }).status : `suppressed:${dec.reasons.join(',')}`;
    }
    const s: Spin = { request_id: key, player_id: player, game_id: id, nonce, commit: seed.commit, outcome: prize.id, label: prize.label, at: this.#d.clock.now().toISOString(), reward_status };
    this.#spins.set(key, s);
    this.#d.audit.record(tenant, `player:${player}`, 'minigame.spin', id, { nonce, outcome: prize.id, commit: seed.commit, reward_status });
    return s;
  }
  spinsOf(tenant: string, id: string) { return [...this.#spins.values()].filter((s) => s.game_id === id && this.#spinTenant(s) === tenant); }
  /** Costo esperado por tirada (unidades mínimas) y XP esperado. */
  expected(tenant: string, g: MiniGame) {
    const total = g.prizes.reduce((s, p) => s + p.weight, 0);
    return {
      cost_per_spin_minor: Math.round(g.prizes.reduce((s, p) => s + (p.weight / total) * (p.prize.reward_id ? this.#d.rewards.item(tenant, p.prize.reward_id)?.value.amount_minor ?? 0 : 0), 0)),
      xp_per_spin: +g.prizes.reduce((s, p) => s + (p.weight / total) * (p.prize.xp ?? 0), 0).toFixed(2),
      probabilities: g.prizes.map((p) => ({ id: p.id, label: p.label, p: p.weight / total })),
    };
  }
}

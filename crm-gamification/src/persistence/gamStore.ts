/**
 * Persistencia de la gamificación ampliada (migración 003): retos por versión, inscripciones con su
 * progreso por período, estado de logros por jugador (contadores, desbloqueos, alias), enlaces
 * compartidos y contadores de tarjetas. Escritura por lotes (≈20 ms), con RLS por tenant.
 */
import type { App } from '../app.ts';
import type { PlayerAchState, ShareLink, ShareMetric } from '../gamification/achievements.ts';
import type { Challenge, Enrollment } from '../gamification/challenges.ts';
import type { Gift, GiftAssignment } from '../gamification/gifts.ts';
import type { Tournament, TournamentEntry } from '../gamification/games.ts';
type Pref = { tenant_id: string; player_id: string; hidden: boolean };
import { withTenant, type Db } from './db.ts';

type Metrics = { tenant_id: string; achievement_id: string; counts: Record<ShareMetric, number> };

export class PgGamStore {
  #db: Db;
  constructor(db: Db) { this.#db = db; }
  async write(tenant: string, x: { challenges: Challenge[]; enrollments: Enrollment[]; players: PlayerAchState[]; links: ShareLink[]; metrics: Metrics[]; gifts?: Gift[]; giftAssignments?: GiftAssignment[]; tournaments?: Tournament[]; entries?: TournamentEntry[]; prefs?: Pref[] }) {
    await withTenant(this.#db, tenant, async (c) => {
      for (const ch of x.challenges) await c.query(
        `INSERT INTO gamification_definitions (tenant_id, kind, id, status, definition, created_by, approved_by, updated_at) VALUES ($1,'challenge',$2,$3,$4,$5,$6,now())
         ON CONFLICT (tenant_id, kind, id) DO UPDATE SET status = EXCLUDED.status, definition = EXCLUDED.definition, approved_by = EXCLUDED.approved_by, updated_at = now()`,
        [tenant, `${ch.id}@v${ch.version}`, ch.status, JSON.stringify(ch), ch.created_by, ch.approved_by ?? null]);
      for (const g of x.gifts ?? []) await c.query(
        `INSERT INTO gamification_definitions (tenant_id, kind, id, status, definition, created_by, approved_by, updated_at) VALUES ($1,'gift',$2,$3,$4,$5,$6,now())
         ON CONFLICT (tenant_id, kind, id) DO UPDATE SET status = EXCLUDED.status, definition = EXCLUDED.definition, approved_by = EXCLUDED.approved_by, updated_at = now()`,
        [tenant, g.id, g.status, JSON.stringify(g), g.created_by, g.approved_by ?? null]);
      for (const t of x.tournaments ?? []) await c.query(
        `INSERT INTO gamification_definitions (tenant_id, kind, id, status, definition, created_by, approved_by, updated_at) VALUES ($1,'tournament',$2,$3,$4,$5,$6,now())
         ON CONFLICT (tenant_id, kind, id) DO UPDATE SET status = EXCLUDED.status, definition = EXCLUDED.definition, approved_by = EXCLUDED.approved_by, updated_at = now()`,
        [tenant, t.id, t.status, JSON.stringify(t), t.created_by, t.approved_by ?? t.final?.approved_by ?? null]);
      const prog = (kind: string, id: string, player: string, state: unknown) => c.query(
        `INSERT INTO gamification_progress (tenant_id, kind, id, player_id, state, updated_at) VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (tenant_id, kind, id, player_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`, [tenant, kind, id, player, JSON.stringify(state)]);
      for (const e of x.enrollments) await prog('challenge', e.challenge_id, e.player_id, e);
      for (const p of x.players) await prog('achievements', 'state', p.player_id, p);
      for (const l of x.links) await prog('share_link', l.id, l.player_id, l);
      for (const m of x.metrics) await prog('share_metrics', m.achievement_id, '-', m);
      for (const a of x.giftAssignments ?? []) await prog('gift', a.gift_id, a.player_id, a);
      for (const e of x.entries ?? []) await prog('tournament_entry', e.tournament_id, e.player_id, e);
      for (const p of x.prefs ?? []) await prog('leaderboard_pref', 'visibility', p.player_id, p);
    });
  }
  async load(tenant: string) {
    return withTenant(this.#db, tenant, async (c) => {
      const drows = (await c.query(`SELECT kind, definition FROM gamification_definitions WHERE kind IN ('challenge','gift','tournament')`)).rows;
      const defs = drows.filter((r) => r.kind === 'challenge').map((r) => r.definition as Challenge);
      const rows = (await c.query(`SELECT kind, state FROM gamification_progress WHERE kind IN ('challenge','achievements','share_link','share_metrics','gift','tournament_entry','leaderboard_pref')`)).rows;
      const of = <T,>(k: string) => rows.filter((r) => r.kind === k).map((r) => r.state as T);
      return { challenges: defs, enrollments: of<Enrollment>('challenge'), players: of<PlayerAchState>('achievements'), links: of<ShareLink>('share_link'), metrics: of<Metrics>('share_metrics'),
        gifts: drows.filter((r) => r.kind === 'gift').map((r) => r.definition as Gift), giftAssignments: of<GiftAssignment>('gift'),
        tournaments: drows.filter((r) => r.kind === 'tournament').map((r) => r.definition as Tournament), entries: of<TournamentEntry>('tournament_entry'), prefs: of<Pref>('leaderboard_pref') };
    });
  }
}

/** Conecta los servicios con la base: encola cada cambio y lo escribe por lotes. */
export function attachGam(app: App, store: PgGamStore, onError: (e: unknown) => void = (e) => console.error('[persistencia de gamificación]', e)) {
  type Q = { challenges: Map<string, Challenge>; enrollments: Map<string, Enrollment>; players: Map<string, PlayerAchState>; links: Map<string, ShareLink>; metrics: Map<string, Metrics>; gifts: Map<string, Gift>; giftAssignments: Map<string, GiftAssignment>; tournaments: Map<string, Tournament>; entries: Map<string, TournamentEntry>; prefs: Map<string, Pref> };
  const by = new Map<string, Q>();
  const q = (t: string) => { let x = by.get(t); if (!x) by.set(t, (x = { challenges: new Map(), enrollments: new Map(), players: new Map(), links: new Map(), metrics: new Map(), gifts: new Map(), giftAssignments: new Map(), tournaments: new Map(), entries: new Map(), prefs: new Map() })); return x; };
  let chain: Promise<unknown> = Promise.resolve(); let timer: ReturnType<typeof setTimeout> | null = null;
  const drain = async () => { const b = [...by]; by.clear(); for (const [t, x] of b) await store.write(t, { challenges: [...x.challenges.values()], enrollments: [...x.enrollments.values()], players: [...x.players.values()], links: [...x.links.values()], metrics: [...x.metrics.values()], gifts: [...x.gifts.values()], giftAssignments: [...x.giftAssignments.values()], tournaments: [...x.tournaments.values()], entries: [...x.entries.values()], prefs: [...x.prefs.values()] }); };
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; chain = chain.then(drain).catch(onError); }, 20); };
  app.challenges.onChange = (x) => {
    for (const c of x.challenges ?? []) q(c.tenant_id).challenges.set(`${c.id}@${c.version}`, structuredClone(c));
    for (const e of x.enrollments ?? []) q(e.tenant_id).enrollments.set(`${e.challenge_id}:${e.player_id}`, structuredClone(e));
    schedule();
  };
  app.achievements.onChange = (x) => {
    for (const p of x.players ?? []) q(p.tenant_id).players.set(p.player_id, structuredClone(p));
    for (const l of x.links ?? []) q(l.tenant_id).links.set(l.id, { ...l });
    for (const m of x.metrics ?? []) q(m.tenant_id).metrics.set(m.achievement_id, structuredClone(m));
    schedule();
  };
  app.gifts.onChange = (x) => {
    for (const g of x.gifts ?? []) q(g.tenant_id).gifts.set(g.id, structuredClone(g));
    for (const a of x.assignments ?? []) q(a.tenant_id).giftAssignments.set(`${a.gift_id}:${a.player_id}`, structuredClone(a));
    schedule();
  };
  app.games.onChange = (x) => {
    for (const t of x.tournaments ?? []) q(t.tenant_id).tournaments.set(t.id, structuredClone(t));
    for (const e of x.entries ?? []) q(e.tenant_id).entries.set(`${e.tournament_id}:${e.player_id}`, structuredClone(e));
    schedule();
  };
  app.leaderboards.onChange = (p) => { q(p.tenant_id).prefs.set(p.player_id, { ...p }); schedule(); };
  return {
    flush: async () => { while (timer || by.size) { if (timer) { clearTimeout(timer); timer = null; } chain = chain.then(drain).catch(onError); await chain; } await chain; },
  };
}

export async function loadGam(app: App, store: PgGamStore, tenants: string[]) {
  let n = 0;
  for (const t of tenants) {
    const d = await store.load(t);
    app.challenges.restore({ challenges: d.challenges, enrollments: d.enrollments });
    app.achievements.restore({ players: d.players, links: d.links, metrics: d.metrics });
    app.gifts.restore({ gifts: d.gifts, assignments: d.giftAssignments });
    app.games.restore({ tournaments: d.tournaments, entries: d.entries });
    app.leaderboards.restore(d.prefs);
    n += d.tournaments.length + d.entries.length + d.gifts.length + d.giftAssignments.length + d.challenges.length + d.enrollments.length + d.players.length + d.links.length;
  }
  return n;
}

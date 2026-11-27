/**
 * Libros durables de XP (loyalty_ledger) y monedas (coin_ledger + coin_balances), migración 004.
 * Append-only: cada asiento se inserta una vez (único por tenant y ref) y el saldo de monedas se
 * mantiene en la misma transacción, con la restricción `balance >= 0` de la base. Al arrancar se cargan
 * todos los asientos; en cada ciclo se leen los que escribió otra réplica (por id creciente).
 */
import type { App } from '../app.ts';
import type { CoinEntry } from '../gamification/store.ts';
import type { LedgerEntry } from '../loyalty/loyalty.ts';
import { withTenant, type Db } from './db.ts';

type Xp = LedgerEntry & { brand_id: string };

export class PgLedgerStore {
  #db: Db;
  constructor(db: Db) { this.#db = db; }
  async write(tenant: string, xp: Xp[], coins: CoinEntry[]) {
    await withTenant(this.#db, tenant, async (c) => {
      for (const e of xp) await c.query(
        `INSERT INTO loyalty_ledger (tenant_id, brand_id, player_id, points, reason, ref, at, entry_id, season, compensates) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (tenant_id, ref) DO NOTHING`, [tenant, e.brand_id, e.player_id, e.points, e.reason, e.ref, e.at, e.entry_id, e.season, e.compensates ?? null]);
      for (const e of coins) {
        const r = await c.query(`INSERT INTO coin_ledger (tenant_id, player_id, amount, reason, ref, at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, ref) DO NOTHING`, [tenant, e.player_id, e.amount, e.reason, e.ref, e.at]);
        if (!r.rowCount) continue;
        // fila en 0 y luego suma: con INSERT … ON CONFLICT la restricción `balance >= 0` se evaluaría sobre el monto suelto
        await c.query(`INSERT INTO coin_balances (tenant_id, player_id, balance) VALUES ($1,$2,0) ON CONFLICT (tenant_id, player_id) DO NOTHING`, [tenant, e.player_id]);
        await c.query(`UPDATE coin_balances SET balance = balance + $2 WHERE player_id = $1`, [e.player_id, e.amount]);
      }
    });
  }
  /** Asientos con id mayor que los cursores dados. */
  async load(tenant: string, after = { xp: 0, coins: 0 }) {
    return withTenant(this.#db, tenant, async (c) => {
      const xp = (await c.query(`SELECT id, tenant_id, brand_id, player_id, points, reason, ref, at, entry_id, season, compensates FROM loyalty_ledger WHERE id > $1 ORDER BY id`, [after.xp])).rows;
      const coins = (await c.query(`SELECT id, player_id, amount, reason, ref, at FROM coin_ledger WHERE id > $1 ORDER BY id`, [after.coins])).rows;
      const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
      return {
        xp: xp.map((r): LedgerEntry => ({ entry_id: r.entry_id ?? `le_${r.ref}`, tenant_id: r.tenant_id, player_id: r.player_id, season: r.season, points: Number(r.points), reason: r.reason, ref: r.ref, ...(r.compensates ? { compensates: r.compensates } : {}), at: iso(r.at) })),
        coins: coins.map((r): CoinEntry => ({ id: `c_${r.ref}`, player_id: r.player_id, amount: Number(r.amount), reason: r.reason, ref: r.ref, at: iso(r.at) })),
        cursor: { xp: Math.max(after.xp, ...xp.map((r) => Number(r.id))), coins: Math.max(after.coins, ...coins.map((r) => Number(r.id))) },
      };
    });
  }
  async balance(tenant: string, player: string) {
    return withTenant(this.#db, tenant, async (c) => Number((await c.query(`SELECT balance FROM coin_balances WHERE player_id = $1`, [player])).rows[0]?.balance ?? 0));
  }
}

/** Encola cada asiento nuevo y lo escribe por lotes (≈20 ms), en orden. */
export function attachLedgers(app: App, store: PgLedgerStore, onError: (e: unknown) => void = (e) => console.error('[persistencia de libros]', e)) {
  const by = new Map<string, { xp: Xp[]; coins: CoinEntry[] }>();
  const q = (t: string) => { let x = by.get(t); if (!x) by.set(t, (x = { xp: [], coins: [] })); return x; };
  let chain: Promise<unknown> = Promise.resolve(); let timer: ReturnType<typeof setTimeout> | null = null;
  const drain = async () => { const b = [...by]; by.clear(); for (const [t, x] of b) await store.write(t, x.xp, x.coins); };
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; chain = chain.then(drain).catch(onError); }, 20); };
  app.loyalty.onAppend = (e) => { q(e.tenant_id).xp.push({ ...e }); schedule(); };
  app.store.onCoin = (t, e) => { q(t).coins.push({ ...e }); schedule(); };
  return { flush: async () => { while (timer || by.size) { if (timer) { clearTimeout(timer); timer = null; } chain = chain.then(drain).catch(onError); await chain; } await chain; } };
}

/** Carga (o sincroniza) los libros; devuelve los cursores nuevos y cuántos asientos agregó. */
export async function syncLedgers(app: App, store: PgLedgerStore, tenants: string[], cursors: Map<string, { xp: number; coins: number }>) {
  let n = 0;
  for (const t of tenants) {
    const d = await store.load(t, cursors.get(t));
    n += app.loyalty.restore(d.xp) + app.store.restoreCoins(t, d.coins);
    cursors.set(t, d.cursor);
  }
  return n;
}

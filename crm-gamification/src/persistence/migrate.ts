/**
 * Migraciones SQL versionadas (db/migrations/NNN_nombre.sql), aplicadas en orden, cada
 * una en su transacción, con bloqueo consultivo (dos instancias no migran a la vez) y
 * suma de verificación: si un archivo ya aplicado cambia, se detiene en vez de divergir.
 * Uso: DATABASE_URL=… node src/persistence/migrate.ts
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../shared/util.ts';
import { createPool, type Db } from './db.ts';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');
const LOCK_ID = 7_301_2026;

export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<{ applied: string[]; skipped: string[] }> {
  const c = await db.connect();
  try {
    await c.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Map((await c.query('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [r.version as string, r.checksum as string]));
    const files = (await readdir(dir)).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
    const applied: string[] = [], skipped: string[] = [];
    for (const f of files) {
      const sql = await readFile(join(dir, f), 'utf8');
      const sum = sha256(sql);
      const prev = done.get(f);
      if (prev) {
        if (prev !== sum) throw new Error(`La migración ${f} cambió después de aplicarse (checksum distinto). Crea una migración nueva en lugar de editarla.`);
        skipped.push(f); continue;
      }
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [f, sum]);
        await c.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`Falló ${f}: ${(e as Error).message}`);
      }
    }
    return { applied, skipped };
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    c.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = createPool(process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL);
  migrate(db).then((r) => { console.log(`Migraciones aplicadas: ${r.applied.join(', ') || 'ninguna'} · ya aplicadas: ${r.skipped.length}`); return db.end(); })
    .catch(async (e) => { console.error(e.message); await db.end(); process.exit(1); });
}

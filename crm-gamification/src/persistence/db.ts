/**
 * Conexión a PostgreSQL (solo servidor). La aplicación usa el rol crm_app, sujeto a
 * Row Level Security: toda operación de negocio corre dentro de `withTenant`, que fija
 * `app.tenant_id` para la transacción. Las tareas de mantenimiento (migraciones,
 * reconstrucción de proyecciones) usan un rol con BYPASSRLS, nunca el de la app.
 */
import pg from 'pg';

export type Db = pg.Pool;
export function createPool(url = process.env.DATABASE_URL, max = Number(process.env.DATABASE_POOL_MAX ?? 10)): Db {
  if (!url) throw new Error('Falta DATABASE_URL (p. ej. postgres://crm_app:***@host:5432/crm).');
  const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000, statement_timeout: 15_000, application_name: 'ss1-crm' });
  // bigint (int8) como número: los montos en unidades mínimas caben de sobra en 2^53
  pg.types.setTypeParser(20, (v) => Number(v));
  return pool;
}

/** Transacción con el tenant fijado para RLS. */
export async function withTenant<T>(db: Db, tenant: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally { c.release(); }
}

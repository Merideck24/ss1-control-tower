/**
 * Pila de servicios para las pruebas: web (CRM_ROLE=web) y worker independientes, sobre una base
 * PostgreSQL de prueba propia (se crea y migra al arrancar). Datos sintéticos; sin credenciales de SS1.
 *
 * Auth: CRM_DEV_AUTH=1 (rol y tenant por cabecera). Es la única concesión frente a producción: la
 * identidad real de SS1 (GET /admin/auth/me) no está disponible en CI.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { ROOT } from './env.ts';

export const E2E_DB = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL;
export type Stack = { name: string; port: number; base: string; dbUrl: string; web?: ChildProcess; worker?: ChildProcess; logDir: string };

export async function createDb(name: string): Promise<string> {
  if (!E2E_DB) throw new Error('Falta E2E_DATABASE_URL (rol administrador sobre un servidor PostgreSQL de pruebas).');
  const root = new pg.Client({ connectionString: E2E_DB });
  await root.connect();
  await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await root.query(`CREATE DATABASE ${name}`);
  await root.end();
  const u = new URL(E2E_DB); u.pathname = '/' + name;
  const url = u.toString();
  await run(['src/persistence/migrate.ts'], { DATABASE_URL: url });
  return url;
}

function run(args: string[], env: Record<string, string>): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`${args.join(' ')} → ${c}: ${err}`))));
  });
}

const envFor = (s: Stack, extra: Record<string, string> = {}) => ({
  DATABASE_URL: s.dbUrl, CRM_DEV_AUTH: '1', PORT: String(s.port), CRM_TENANTS: 'tenant-rumbawin,tenant-demo-b',
  CRM_SYNC_INTERVAL_MS: '300', CRM_WORKER_INTERVAL_MS: '300', NODE_ENV: 'production', ...extra,
});

function launch(s: Stack, which: 'web' | 'worker', extra: Record<string, string>): ChildProcess {
  mkdirSync(s.logDir, { recursive: true });
  const log = createWriteStream(join(s.logDir, `${s.name}-${which}.log`), { flags: 'a' });
  const args = which === 'web' ? ['src/api/server.ts'] : ['src/worker.ts'];
  const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...envFor(s, which === 'web' ? { CRM_ROLE: 'web', ...extra } : extra) }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout!.pipe(log); p.stderr!.pipe(log);
  return p;
}

export async function waitUp(base: string, ms = 120_000) {
  const until = Date.now() + ms;
  for (;;) {
    try { const r = await fetch(base + '/api/session', { headers: { 'x-tenant-id': 'tenant-rumbawin', 'x-roles': 'crm_analyst', 'x-actor': 'e2e@ss1' } }); if (r.ok) return; } catch { /* aún no escucha */ }
    if (Date.now() > until) throw new Error(`la web no respondió en ${base}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

export async function startWeb(s: Stack, extra: Record<string, string> = {}) { s.web = launch(s, 'web', extra); await waitUp(s.base); }
export async function startWorker(s: Stack) {
  s.worker = launch(s, 'worker', {});
  // listo cuando el worker escribe «activo»
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('el worker no arrancó')), 120_000);
    s.worker!.stdout!.on('data', (d: Buffer) => { if (/activo:/.test(String(d))) { clearTimeout(t); res(); } });
  });
}
export async function stop(p?: ChildProcess) {
  if (!p || p.exitCode !== null) return;
  await new Promise<void>((res) => { p.once('exit', () => res()); p.kill('SIGTERM'); setTimeout(() => { if (p.exitCode === null) p.kill('SIGKILL'); }, 10_000); });
}
export async function stopStack(s: Stack) { await stop(s.web); await stop(s.worker); }

export function stackFor(name: string, port: number, logDir: string): Stack {
  return { name, port, base: `http://127.0.0.1:${port}`, dbUrl: '', logDir };
}

/** Llamada a la API con rol y actor (cada rol actúa como una persona distinta: autor ≠ aprobador). */
export async function api(base: string, role: string, method: string, path: string, body?: unknown, tenant = 'tenant-rumbawin') {
  const r = await fetch(base + '/api' + path, { method, headers: { 'content-type': 'application/json', 'x-tenant-id': tenant, 'x-roles': role, 'x-actor': `${role}@ss1` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: unknown = text; try { json = JSON.parse(text); } catch { /* CSV u otro */ }
  return { status: r.status, body: json as any, text };
}

/** Evento normalizado mínimo para la ingesta. */
export function event(type: string, player: string, payload: Record<string, unknown>, id: string, tenant = 'tenant-rumbawin') {
  return { event_id: id, event_type: type, schema_version: 1, tenant_id: tenant, brand_id: 'rumbawin', player_id: player, occurred_at: new Date().toISOString(), source: type.startsWith('rg') ? 'ss1.rg' : type.startsWith('deposit') ? 'ss1.wallet' : 'ss1.pam', correlation_id: `c-${id}`, payload };
}

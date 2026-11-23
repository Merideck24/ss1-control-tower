import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, seedTenant, type App } from '../app.ts';
import { seedAcquisitionHistory } from '../demoAcquisition.ts';
import { route, type AskFn } from './router.ts';
import { Ss1IdentityProvider } from '../integration/ss1Identity.ts';
import { OffsetClock } from '../shared/util.ts';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), '../../public');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' };

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

/** El copiloto con Claude solo se habilita si hay credenciales Anthropic en el entorno. */
async function loadAsk(): Promise<AskFn | undefined> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_PROFILE) return undefined;
  const { askCopilot } = await import('../copilot/agent.ts');
  return askCopilot;
}

/**
 * Autenticación: con `Authorization: Bearer` se valida contra la API de SS1 y el servidor decide los roles.
 * Las cabeceras de desarrollo (x-roles) solo se aceptan si `devAuth` está activo (CRM_DEV_AUTH=1).
 */
export function createHandler(app: App, ask?: AskFn, auth: { identity?: Ss1IdentityProvider; devAuth?: boolean; apiBase?: string } = {}) {
  return async (req: IncomingMessage, res: import('node:http').ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      const file = normalize(join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
      const data = file.startsWith(PUBLIC) ? await readFile(file).catch(() => null) : null;
      res.writeHead(data ? 200 : 404, { 'content-type': data ? MIME[extname(file)] ?? 'application/octet-stream' : 'text/plain' });
      return res.end(data ?? 'not found');
    }
    let parsed: Record<string, unknown> = {};
    try { parsed = await body(req); } catch { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":"invalid_json"}'); }
    const headers = req.headers as Record<string, string>;
    let actor;
    if (headers.authorization && auth.identity) {
      const r = await auth.identity.resolve(headers.authorization, headers['x-tenant-id']);
      if (!r.ok) { res.writeHead(r.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: r.error })); }
      actor = r.actor;
    } else if (!auth.devAuth) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing_token', message: 'Abre el CRM desde admin.syssoft1.com o activa CRM_DEV_AUTH=1 para la demo local.' }));
    }
    const token = actor ? /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? '')?.[1] : undefined;
    const ss1 = token && auth.identity ? { apiBase: auth.apiBase ?? 'https://api.syssoft1.com', token } : undefined;
    const out = await route(app, { method: req.method ?? 'GET', path: url.pathname.slice(4), query: url.searchParams, headers: actor ? { ...headers, 'x-tenant-id': actor.tenant_id } : headers, body: parsed }, { ask, actor, ss1 });
    res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out.body, null, 2));
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp(new OffsetClock());
  const demoTenants = ['tenant-rumbawin', 'tenant-demo-b'];
  for (const t of demoTenants) { seedTenant(app, t); app.policy.markRgFeedSynced(t); seedAcquisitionHistory(app, t, 90, t === 'tenant-rumbawin' ? 1 : 0.3, t === 'tenant-rumbawin' ? 7 : 11); }
  // demo: simula el latido del feed de juego responsable (en producción lo publica la fuente)
  const heartbeat = () => demoTenants.forEach((t) => app.policy.markRgFeedSynced(t));
  heartbeat();
  setInterval(heartbeat, 60_000).unref();
  const ask = await loadAsk();
  const identity = new Ss1IdentityProvider({ apiBase: process.env.SS1_API_BASE ?? 'https://api.syssoft1.com', profilePath: process.env.SS1_PROFILE_PATH, tenantMap: process.env.CRM_TENANT_MAP ? JSON.parse(process.env.CRM_TENANT_MAP) : {} });
  const devAuth = process.env.CRM_DEV_AUTH === '1';
  const port = Number(process.env.PORT ?? 3000);
  createServer(createHandler(app, ask, { identity, devAuth, apiBase: process.env.SS1_API_BASE ?? 'https://api.syssoft1.com' })).listen(port, () => console.log(`SS1 CRM & Gamificación → http://localhost:${port}${ask ? ' (copiloto Claude habilitado)' : ''}${devAuth ? ' · auth de desarrollo ACTIVA' : ' · auth SS1'}`));
}

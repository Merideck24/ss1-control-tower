import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, seedTenant, type App } from '../app.ts';
import { seedAcquisitionHistory } from '../demoAcquisition.ts';
import { route, type AskFn } from './router.ts';
import { RateLimiter } from '../integration/serviceKeys.ts';
import type { WriterFn } from '../content/studio.ts';
import { Ss1IdentityProvider } from '../integration/ss1Identity.ts';
import { handleWebhook, MAX_BODY_BYTES } from '../integration/webhook.ts';
import { OffsetClock } from '../shared/util.ts';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), '../../public');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' };

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

/** El copiloto con Claude solo se habilita si hay credenciales Anthropic en el entorno. */
/** Escritor de borradores con Claude, solo si hay credenciales de Anthropic (E6). */
async function loadWriter(): Promise<WriterFn | undefined> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_PROFILE) return undefined;
  const { claudeWriter } = await import('../content/claudeWriter.ts');
  return claudeWriter();
}

async function loadAsk(): Promise<AskFn | undefined> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_PROFILE) return undefined;
  const { askCopilot } = await import('../copilot/agent.ts');
  return askCopilot;
}

/**
 * Autenticación: con `Authorization: Bearer` se valida contra la API de SS1 y el servidor decide los roles.
 * Las cabeceras de desarrollo (x-roles) solo se aceptan si `devAuth` está activo (CRM_DEV_AUTH=1).
 */
/** Orígenes del admin que pueden llamar a la API desde el navegador (mismo valor que el modo embebido). */
const CORS_ORIGINS = (process.env.CRM_ALLOWED_ORIGINS ?? 'https://admin.syssoft1.com').split(',').map((o) => o.trim()).filter(Boolean);
const RATE = new RateLimiter(Number(process.env.CRM_SERVICE_RATE_PER_MIN ?? 600));

export function createHandler(app: App, ask?: AskFn, auth: { identity?: Ss1IdentityProvider; devAuth?: boolean; apiBase?: string; webhookSecrets?: Record<string, string>; write?: WriterFn } = {}) {
  return async (req: IncomingMessage, res: import('node:http').ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      const file = normalize(join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
      const data = file.startsWith(PUBLIC) ? await readFile(file).catch(() => null) : null;
      res.writeHead(data ? 200 : 404, { 'content-type': data ? MIME[extname(file)] ?? 'application/octet-stream' : 'text/plain' });
      return res.end(data ?? 'not found');
    }
    // CORS para las vistas nativas del admin: solo los orígenes permitidos (CRM_ALLOWED_ORIGINS), nunca '*'
    const origin = req.headers.origin;
    if (origin && CORS_ORIGINS.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type, accept');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
      res.setHeader('access-control-max-age', '600');
    }
    if (req.method === 'OPTIONS') { res.writeHead(origin && CORS_ORIGINS.includes(origin) ? 204 : 403); return res.end(); }
    // Webhook máquina a máquina del PAM: se autentica con firma HMAC, no con token de usuario
    if (url.pathname === '/api/ingest/ss1') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      const chunks: Buffer[] = []; let size = 0;
      for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY_BYTES) { res.writeHead(413, { 'content-type': 'application/json' }); return res.end('{"error":"payload_too_large"}'); } chunks.push(c as Buffer); }
      const out = handleWebhook({ secrets: auth.webhookSecrets ?? {}, tenantHeader: req.headers['x-ss1-tenant'] as string | undefined, signatureHeader: req.headers['x-ss1-signature'] as string | undefined, rawBody: Buffer.concat(chunks).toString('utf8'), ingestor: app.ingestor });
      res.writeHead(out.status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out.body));
    }
    let parsed: Record<string, unknown> = {};
    try { parsed = await body(req); } catch { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":"invalid_json"}'); }
    const headers = req.headers as Record<string, string>;
    const json = (status: number, b: unknown, extra: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra }); return res.end(JSON.stringify(b)); };
    // Públicos: estado y especificación (sin datos de negocio)
    const apiPath = url.pathname.replace(/^\/api(\/v1)?/, '');
    if (req.method === 'GET' && (apiPath === '/health' || apiPath === '/openapi.json')) {
      const out = await route(app, { method: 'GET', path: apiPath, query: url.searchParams, headers: {}, body: {} }, { actor: { id: 'public', tenant_id: '', roles: [] } });
      return json(out.status, out.body, { 'cache-control': 'no-store' });
    }
    let actor;
    const bearer = /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? '')?.[1];
    if (bearer?.startsWith('ss1crm_')) {
      // Llave de servicio (máquina a máquina): tenant y alcances salen de la llave, nunca de cabeceras
      const svc = app.serviceKeys.authenticate(bearer);
      if (!svc) return json(401, { error: 'invalid_service_key', message: 'Llave de servicio no válida o revocada.' });
      const lim = RATE.take(svc.key_id);
      if (!lim.ok) return json(429, { error: 'rate_limited', message: 'Demasiadas peticiones con esta llave.' }, { 'retry-after': String(lim.retry_after_s) });
      const out = await route(app, { method: req.method ?? 'GET', path: url.pathname.slice(4), query: url.searchParams, headers: { 'x-tenant-id': svc.tenant_id }, body: parsed }, { actor: svc as never });
      if (out.contentType) { res.writeHead(out.status, { 'content-type': out.contentType }); return res.end(String(out.body)); }
      return json(out.status, out.body);
    }
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
    const out = await route(app, { method: req.method ?? 'GET', path: url.pathname.slice(4), query: url.searchParams, headers: actor ? { ...headers, 'x-tenant-id': actor.tenant_id } : headers, body: parsed }, { ask, write: auth.write, actor, ss1 });
    if (out.contentType) { res.writeHead(out.status, { 'content-type': out.contentType, ...(out.filename ? { 'content-disposition': `attachment; filename="${out.filename}"` } : {}) }); return res.end(String(out.body)); }
    res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out.body, null, 2));
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp(new OffsetClock(), { demoProviders: !process.env.CRM_PROVIDERS_LIVE });
  const demoTenants = (process.env.CRM_TENANTS ?? 'tenant-rumbawin,tenant-demo-b').split(',').map((t) => t.trim()).filter(Boolean);
  if (process.env.DATABASE_URL) {
    // Con base de datos: continuar la auditoría, guardar todo lo nuevo y reconstruir desde el registro
    const { createPool } = await import('../persistence/db.ts');
    const { PgAuditStore, PgEventStore, attachPersistence, rebuildFromStore } = await import('../persistence/stores.ts');
    const db = createPool();
    const maintenance = process.env.DATABASE_MAINTENANCE_URL ? createPool(process.env.DATABASE_MAINTENANCE_URL, 2) : db;
    const events = new PgEventStore(db), audit = new PgAuditStore(db);
    const last = await audit.last(maintenance);
    if (last) app.audit.resume(last.seq, last.hash);
    attachPersistence(app, events, audit);
    for (const t of demoTenants) { seedTenant(app, t); app.policy.markRgFeedSynced(t); }
    const r = await rebuildFromStore(app, events, demoTenants);
    console.log(`Persistencia PostgreSQL activa: ${r.events} eventos reconstruidos; auditoría continúa en #${last?.seq ?? 0}.`);
    if (process.env.CRM_DEMO_SEED === '1' && r.events === 0) for (const t of demoTenants) seedAcquisitionHistory(app, t, 90, t === 'tenant-rumbawin' ? 1 : 0.3, t === 'tenant-rumbawin' ? 7 : 11);
  } else {
    for (const t of demoTenants) { seedTenant(app, t); app.policy.markRgFeedSynced(t); seedAcquisitionHistory(app, t, 90, t === 'tenant-rumbawin' ? 1 : 0.3, t === 'tenant-rumbawin' ? 7 : 11); }
  }
  // demo: simula el latido del feed de juego responsable (en producción lo publica la fuente)
  const heartbeat = () => demoTenants.forEach((t) => app.policy.markRgFeedSynced(t));
  heartbeat();
  setInterval(heartbeat, 60_000).unref();
  // J2: entrega de webhooks salientes (con transporte real salvo en la demo)
  if (process.env.CRM_PROVIDERS_LIVE) app.webhooks.setTransport(async (r) => ({ status: (await fetch(r.url, { method: 'POST', headers: r.headers, body: r.body, redirect: 'error', signal: AbortSignal.timeout(10_000) })).status }));
  setInterval(() => { void app.webhooks.dispatch(); }, 10_000).unref();
  const ask = await loadAsk();
  const write = await loadWriter();
  const identity = new Ss1IdentityProvider({ apiBase: process.env.SS1_API_BASE ?? 'https://api.syssoft1.com', profilePath: process.env.SS1_PROFILE_PATH, tenantMap: process.env.CRM_TENANT_MAP ? JSON.parse(process.env.CRM_TENANT_MAP) : {} });
  const devAuth = process.env.CRM_DEV_AUTH === '1';
  const port = Number(process.env.PORT ?? 3000);
  const webhookSecrets = process.env.CRM_WEBHOOK_SECRETS ? JSON.parse(process.env.CRM_WEBHOOK_SECRETS) as Record<string, string> : {};
  createServer(createHandler(app, ask, { identity, devAuth, apiBase: process.env.SS1_API_BASE ?? 'https://api.syssoft1.com', webhookSecrets, write })).listen(port, () => console.log(`SS1 CRM & Gamificación → http://localhost:${port}${ask ? ' (copiloto Claude habilitado)' : ''}${write ? ' (borradores con IA habilitados)' : ''}${devAuth ? ' · auth de desarrollo ACTIVA' : ' · auth SS1'}`));
}

import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, seedTenant, type App } from '../app.ts';
import { seedDemoPlayers } from '../demoData.ts';
import { seedAcquisitionHistory } from '../demoAcquisition.ts';
import { route, type AskFn } from './router.ts';
import { OffsetClock } from '../shared/util.ts';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), '../../public');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

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

export function createHandler(app: App, ask?: AskFn) {
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
    const out = await route(app, { method: req.method ?? 'GET', path: url.pathname.slice(4), query: url.searchParams, headers: req.headers as Record<string, string>, body: parsed }, { ask });
    res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out.body, null, 2));
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp(new OffsetClock());
  const demoTenants = ['tenant-rumbawin', 'tenant-demo-b'];
  for (const t of demoTenants) { seedTenant(app, t); app.policy.markRgFeedSynced(t); seedAcquisitionHistory(app, t, 90, t === 'tenant-rumbawin' ? 1 : 0.3, t === 'tenant-rumbawin' ? 7 : 11); seedDemoPlayers(app, t, t === 'tenant-rumbawin' ? 40 : 12); }
  // demo: simula el latido del feed de juego responsable (en producción lo publica la fuente)
  const heartbeat = () => demoTenants.forEach((t) => app.policy.markRgFeedSynced(t));
  heartbeat();
  setInterval(heartbeat, 60_000).unref();
  const ask = await loadAsk();
  const port = Number(process.env.PORT ?? 3000);
  createServer(createHandler(app, ask)).listen(port, () => console.log(`SS1 CRM & Gamificación → http://localhost:${port}${ask ? ' (copiloto Claude habilitado)' : ''}`));
}

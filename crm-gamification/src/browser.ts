/**
 * Versión estática: ejecuta el mismo dominio en el navegador con datos sintéticos
 * e intercepta fetch('/api/…') con el enrutador puro. Sin servidor ni red.
 */
import { createApp, seedTenant } from './app.ts';
import { seedDemoPlayers } from './demoData.ts';
import { route } from './api/router.ts';
import { OffsetClock } from './shared/util.ts';

const app = createApp(new OffsetClock());
for (const t of ['tenant-rumbawin', 'tenant-demo-b']) { seedTenant(app, t); seedDemoPlayers(app, t, t === 'tenant-rumbawin' ? 40 : 12); }
for (const t of app.tenants) app.policy.markRgFeedSynced(t);
setInterval(() => app.tenants.forEach((t) => app.policy.markRgFeedSynced(t)), 60_000);

const realFetch = globalThis.fetch?.bind(globalThis);
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, 'http://static.local');
  if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const out = await route(app, { method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname.slice(4), query: url.searchParams, headers, body });
  return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json' } });
};
(globalThis as { SS1_STATIC?: boolean }).SS1_STATIC = true;

/**
 * Versión estática: ejecuta el mismo dominio en el navegador con datos sintéticos
 * e intercepta fetch('/api/…') con el enrutador puro. Sin servidor ni red.
 */
import { createApp, seedTenant } from './app.ts';
import { seedAcquisitionHistory } from './demoAcquisition.ts';
import { route } from './api/router.ts';
import { OffsetClock } from './shared/util.ts';
import { abilitiesToRoles, DEFAULT_ALLOWED_ORIGINS } from './integration/ss1Auth.ts';
import { deriveBrandTokens, parseThemeConfig } from './integration/theme.ts';

const app = createApp(new OffsetClock(), { demoProviders: true });
for (const t of ['tenant-rumbawin', 'tenant-demo-b']) { seedTenant(app, t); app.policy.markRgFeedSynced(t); seedAcquisitionHistory(app, t, 90, t === 'tenant-rumbawin' ? 1 : 0.3, t === 'tenant-rumbawin' ? 7 : 11); }
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
(globalThis as { SS1_INTEGRATION?: unknown }).SS1_INTEGRATION = { abilitiesToRoles, DEFAULT_ALLOWED_ORIGINS, deriveBrandTokens, parseThemeConfig };

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
setInterval(() => { void app.webhooks.dispatch(); }, 5_000);

/**
 * #7: la demo estática vive en la memoria del navegador. Para que una recarga no pierda borradores,
 * aprobaciones ni acciones, cada escritura que sale bien se anota en localStorage y se vuelve a
 * aplicar, en orden, al abrir la página (antes de responder a la interfaz).
 */
type Entry = { method: string; path: string; query: string; headers: Record<string, string>; body: unknown };
const JOURNAL_KEY = 'ss1-crm-demo-journal-v1';
const JOURNAL_MAX = 2000;
const readJournal = (): Entry[] => { try { return JSON.parse(globalThis.localStorage?.getItem(JOURNAL_KEY) ?? '[]'); } catch { return []; } };
const journal: Entry[] = readJournal();
const saveJournal = () => { try { globalThis.localStorage?.setItem(JOURNAL_KEY, JSON.stringify(journal.slice(-JOURNAL_MAX))); } catch { /* sin almacenamiento: la demo sigue, sin persistir */ } };
const ready = (async () => {
  for (const e of journal) { try { await route(app, { method: e.method, path: e.path, query: new URLSearchParams(e.query), headers: e.headers, body: e.body as Record<string, unknown> }); } catch { /* una entrada inválida no bloquea las demás */ } }
})();
(globalThis as { SS1_DEMO?: unknown }).SS1_DEMO = {
  actions: () => journal.length,
  reset: () => { try { globalThis.localStorage?.removeItem(JOURNAL_KEY); globalThis.localStorage?.removeItem('ss1-crm-route-v1'); } catch { /* nada */ } globalThis.location?.reload(); },
};

const realFetch = globalThis.fetch?.bind(globalThis);
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, 'http://static.local');
  if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
  await ready;
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const method = (init?.method ?? 'GET').toUpperCase();
  const out = await route(app, { method, path: url.pathname.slice(4), query: url.searchParams, headers, body });
  if (method !== 'GET' && out.status < 400) { journal.push({ method, path: url.pathname.slice(4), query: url.search, headers, body }); saveJournal(); }
  if (out.contentType) return new Response(String(out.body), { status: out.status, headers: { 'content-type': out.contentType } });
  return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json' } });
};
(globalThis as { SS1_STATIC?: boolean }).SS1_STATIC = true;
(globalThis as { SS1_INTEGRATION?: unknown }).SS1_INTEGRATION = { abilitiesToRoles, DEFAULT_ALLOWED_ORIGINS, deriveBrandTokens, parseThemeConfig };

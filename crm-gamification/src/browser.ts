/**
 * Versión estática: ejecuta el mismo dominio en el navegador con datos sintéticos
 * e intercepta fetch('/api/…') con el enrutador puro. Sin servidor ni red.
 */
import { createApp, seedTenant, withEventSeq } from './app.ts';
import { seedAcquisitionHistory } from './demoAcquisition.ts';
import { route } from './api/router.ts';
import { DemoClock, startOfBogotaDay, useDeterministicIds, useRandomIds } from './shared/util.ts';
import { abilitiesToRoles, DEFAULT_ALLOWED_ORIGINS } from './integration/ss1Auth.ts';
import { deriveBrandTokens, parseThemeConfig } from './integration/theme.ts';

/**
 * Datos reproducibles: la historia sintética se genera con un reloj congelado en las 00:00 de hoy
 * (hora de Bogotá) e identificadores derivados de esa fecha y del tenant, así dos recargas del mismo
 * día muestran exactamente las mismas cifras. `?fecha=AAAA-MM-DD` fija la fecha (p. ej., para presentar).
 */
const params = new URLSearchParams(globalThis.location?.search ?? '');
const fixed = /^\d{4}-\d{2}-\d{2}$/.test(params.get('fecha') ?? '') ? Date.parse(`${params.get('fecha')}T05:00:00Z`) : NaN;
const anchor = Number.isNaN(fixed) ? startOfBogotaDay(Date.now()) : fixed;
const DAY_KEY = new Date(anchor).toISOString().slice(0, 10);
const clock = new DemoClock(anchor);
const app = createApp(clock, { demoProviders: true });
const DEMO_TENANTS: Record<string, { scale: number; seed: number }> = { 'tenant-rumbawin': { scale: 1, seed: 7 }, 'tenant-demo-b': { scale: 0.3, seed: 11 } };
const boot: Record<string, number> = {};
const msNow = () => (globalThis.performance?.now?.() ?? Date.now());
let live = false;

/** Siembra un tenant con el reloj congelado en el ancla; luego vuelve a la hora real. Solo una vez. */
function ensureTenant(t: string) {
  const cfg = DEMO_TENANTS[t];
  if (!cfg || app.tenants.includes(t)) return;
  const t0 = msNow();
  if (live) clock.freeze(anchor);
  useDeterministicIds(`ss1-demo:${DAY_KEY}:${t}`);
  // base de ids propia por tenant: no depende de lo que se haya hecho antes en la página
  withEventSeq(Object.keys(DEMO_TENANTS).indexOf(t) * 10_000_000, () => { seedTenant(app, t); app.policy.markRgFeedSynced(t); seedAcquisitionHistory(app, t, 90, cfg.scale, cfg.seed); });
  useRandomIds();
  if (live) clock.resume();
  else { live = true; clock.goLive(Number.isNaN(fixed) ? undefined : anchor + 9 * 3_600_000); } // fecha fija: arranca a las 9:00
  app.policy.markRgFeedSynced(t);
  boot[t] = Math.round(msNow() - t0);
}
(globalThis as { SS1_DEMO_DATE?: string }).SS1_DEMO_DATE = DAY_KEY;
(globalThis as { SS1_BOOT_MS?: unknown }).SS1_BOOT_MS = boot;
setInterval(() => app.tenants.forEach((t) => app.policy.markRgFeedSynced(t)), 60_000);
setInterval(() => { void app.webhooks.dispatch(); }, 5_000);

/**
 * #7: la demo estática vive en la memoria del navegador. Para que una recarga no pierda borradores,
 * aprobaciones ni acciones, cada escritura que sale bien se anota en localStorage y se vuelve a
 * aplicar, en orden, al abrir la página (antes de responder a la interfaz).
 */
type Entry = { method: string; path: string; query: string; headers: Record<string, string>; body: unknown; day?: string };
/**
 * Acciones de juego del jugador (ruleta, predicciones, tienda, bandeja): pertenecen al día en que se
 * hicieron. Al cambiar de día no se reaplican, porque se contarían como de hoy (p. ej. consumirían la
 * tirada diaria). Borradores, aprobaciones y configuración sí se conservan.
 */
const DAILY_ACTION = /^\/(gamification\/(minigames\/[^/]+\/spin|predictions\/[^/]+\/pick|store\/redeem)|players\/[^/]+\/inbox\/)/;
const JOURNAL_KEY = 'ss1-crm-demo-journal-v1';
const JOURNAL_MAX = 2000;
const readJournal = (): Entry[] => { try { return JSON.parse(globalThis.localStorage?.getItem(JOURNAL_KEY) ?? '[]'); } catch { return []; } };
const journal: Entry[] = readJournal();
const saveJournal = () => { try { globalThis.localStorage?.setItem(JOURNAL_KEY, JSON.stringify(journal.slice(-JOURNAL_MAX))); } catch { /* sin almacenamiento: la demo sigue, sin persistir */ } };
const tenantOf = (h: Record<string, string>) => h['x-tenant-id'] ?? 'tenant-rumbawin';
/**
 * Arranque: primero se pinta la página («Preparando la demo…») y recién después se siembra, en la
 * siguiente tarea. El segundo tenant se siembra solo cuando alguien lo elige.
 */
const ready = new Promise<void>((resolve) => {
  const go = async () => {
    ensureTenant('tenant-rumbawin');
    for (const e of journal) {
      if (DAILY_ACTION.test(e.path) && e.day !== DAY_KEY) continue;
      ensureTenant(tenantOf(e.headers));
      try { await route(app, { method: e.method, path: e.path, query: new URLSearchParams(e.query), headers: e.headers, body: e.body as Record<string, unknown> }); } catch { /* una entrada inválida no bloquea las demás */ }
    }
    resolve();
  };
  const raf = (globalThis as { requestAnimationFrame?: (f: () => void) => void }).requestAnimationFrame;
  if (raf) raf(() => setTimeout(go, 0)); else setTimeout(go, 0);
});
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
  ensureTenant(tenantOf(headers));
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const method = (init?.method ?? 'GET').toUpperCase();
  const out = await route(app, { method, path: url.pathname.slice(4), query: url.searchParams, headers, body });
  if (method !== 'GET' && out.status < 400) { journal.push({ method, path: url.pathname.slice(4), query: url.search, headers, body, day: DAY_KEY }); saveJournal(); }
  if (out.contentType) return new Response(String(out.body), { status: out.status, headers: { 'content-type': out.contentType } });
  return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json' } });
};
(globalThis as { SS1_STATIC?: boolean }).SS1_STATIC = true;
(globalThis as { SS1_INTEGRATION?: unknown }).SS1_INTEGRATION = { abilitiesToRoles, DEFAULT_ALLOWED_ORIGINS, deriveBrandTokens, parseThemeConfig };

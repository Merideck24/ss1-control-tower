import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';

test('El paquete de navegador carga sin APIs de Node y atiende /api con el enrutador', async () => {
  const out = await build({ entryPoints: ['src/browser.ts'], bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent' });
  let fetchImpl: ((u: string, i?: RequestInit) => Promise<Response>) | undefined;
  const ctx: Record<string, unknown> = {
    console, setTimeout, clearTimeout, setInterval: () => 0, URL, URLSearchParams, Headers, Response, TextEncoder, AbortController,
    Intl, crypto: globalThis.crypto, structuredClone, fetch: async () => new Response('nope', { status: 599 }),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  assert.equal(typeof (ctx as { process?: unknown }).process, 'undefined');
  vm.runInContext(out.outputFiles[0].text, ctx, { timeout: 30_000 });
  fetchImpl = ctx.fetch as typeof fetchImpl;
  const res = await fetchImpl!('/api/session', { headers: { 'x-tenant-id': 'tenant-rumbawin', 'x-roles': 'crm_analyst' } });
  assert.equal(res.status, 200);
  const body = await res.json() as { permissions: string[] };
  assert.ok(body.permissions.includes('performance.read'));
  assert.equal(typeof (ctx.SS1_INTEGRATION as { abilitiesToRoles?: unknown }).abilitiesToRoles, 'function');
});

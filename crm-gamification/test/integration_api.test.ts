import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setup, onboard, ev, T } from './helpers.ts';
import { route, PERMISSIONS } from '../src/api/router.ts';
import { CATALOG, findEndpoint } from '../src/api/catalog.ts';
import { buildOpenApi } from '../src/api/openapi.ts';
import { createHandler } from '../src/api/server.ts';
import { RateLimiter } from '../src/integration/serviceKeys.ts';

const ROUTER = new URL('../src/api/router.ts', import.meta.url);

/** Rutas tal como aparecen en el enrutador. */
async function routerRoutes() {
  const src = await readFile(ROUTER, 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(/r0 === '([A-Z]+ [^']+)'/g)) out.add(m[1]);
  for (const m of src.matchAll(/m\(\/\^([A-Z]+ .+?)\$\/\)/g)) out.add(m[1].replace(/\\\//g, '/'));
  return out;
}

test('API: el catálogo documenta exactamente las rutas del enrutador', async () => {
  const real = await routerRoutes();
  const documented = new Set(CATALOG.map((e) => e.route));
  assert.deepEqual([...real].filter((r) => !documented.has(r)), [], 'rutas sin documentar');
  assert.deepEqual([...documented].filter((r) => !real.has(r)), [], 'entradas que no existen en el enrutador');
});

test('API: el permiso declarado en el catálogo es el que exige el enrutador', async () => {
  const { app } = setup();
  for (const e of CATALOG) {
    if (typeof e.perm !== 'string') continue;
    const [method, pattern] = e.route.split(' ');
    const path = pattern.replace(/\(([^()]+)\)/g, (_m, inner: string) => (/^[\w-]+(\|[\w-]+)+$/.test(inner) ? inner.split('|')[0] : 'x1')).replace(/\\\//g, '/');
    const r = await route(app, { method, path, query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': 'nadie', 'x-actor': 'x' }, body: {} });
    assert.equal(r.status, 403, `${e.route} debería exigir ${e.perm}`);
    assert.match((r.body as { message: string }).message, new RegExp(PERMISSIONS[e.perm].join(', ')), `${e.route}: permiso ${e.perm}`);
  }
});

test('API: OpenAPI 3.1 generada desde el catálogo y sin deriva con contracts/openapi.json', async () => {
  const spec = buildOpenApi();
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(Object.values(spec.paths).reduce((n, p) => n + Object.keys(p).length, 0), CATALOG.length);
  const op = spec.paths['/v1/journeys/{journey_id}/{action}'].post as { parameters: { name: string; schema: { enum?: string[] } }[]; security: unknown[] };
  assert.deepEqual(op.parameters.find((p) => p.name === 'action')!.schema.enum, ['submit', 'approve', 'publish', 'pause', 'resume', 'close']);
  assert.deepEqual(op.security, [{ ss1AdminToken: [] }], 'aprobaciones: solo personas');
  const committed = JSON.parse(await readFile(new URL('../contracts/openapi.json', import.meta.url), 'utf8'));
  assert.deepEqual(committed, JSON.parse(JSON.stringify(spec)), 'contracts/openapi.json desactualizado: corre `npm run openapi`');
});

test('API: llaves de servicio — alcances por ruta y por permiso, sin aprobaciones, revocables', async () => {
  const { app, clock } = setup();
  onboard(app, clock, 'p1');
  const admin = { id: 'adm@ss1', tenant_id: T, roles: ['tenant_admin' as const] };
  assert.throws(() => app.serviceKeys.create(admin, { name: 'PAM', scopes: ['todo:poder'] }), /Alcances válidos/);
  const k = app.serviceKeys.create(admin, { name: 'Sitio RumbaWin', scopes: ['players:read', 'onsite:serve', 'players:write', 'events:write'] });
  assert.match(k.key, /^ss1crm_[0-9a-f]{12}_[0-9a-f]{48}$/);
  assert.equal(JSON.stringify(app.serviceKeys.list(T)).includes(k.key.split('_')[2]), false, 'el secreto no se guarda ni se lista');
  const svc = app.serviceKeys.authenticate(k.key)!;
  assert.equal(svc.tenant_id, T);
  const call = (method: string, path: string, body: Record<string, unknown> = {}, q = '') => route(app, { method, path, query: new URLSearchParams(q), headers: {}, body }, { actor: svc as never });
  assert.equal((await call('GET', '/v1/players/p1')).status, 200, 'alcance players:read y prefijo /v1');
  assert.equal((await call('GET', '/onsite/serve/p1', {}, 'placement=home_banner&request_id=r1')).status, 200);
  assert.equal((await call('POST', '/events', ev(T, 'p1', 'deposit.settled', { deposit_id: 'sk1', amount_minor: 100, currency: 'COP' }, clock.now().toISOString()))).status, 202);
  const perf = await call('GET', '/performance');
  assert.deepEqual([perf.status, (perf.body as { error: string }).error], [403, 'scope_required']);
  assert.equal((await call('POST', '/journeys/j1_verification/approve')).status, 403, 'aprobaciones nunca para llaves');
  const rot = await call('POST', '/gamification/minigames/g_daily_wheel/rotate-seed');
  assert.equal(rot.status, 403, 'la ruta admite players:write para girar, pero rotar la semilla exige un permiso que ninguna llave tiene');
  assert.equal((await call('GET', '/integration/service-keys')).status, 403, 'una llave no gestiona llaves');
  app.serviceKeys.revoke(admin, svc.key_id);
  assert.equal(app.serviceKeys.authenticate(k.key), null);
  assert.equal(app.serviceKeys.authenticate(k.key.slice(0, -1) + (k.key.endsWith('0') ? '1' : '0')), null, 'secreto alterado');
  assert.deepEqual(app.audit.list(T).filter((a) => a.action.startsWith('service_key')).map((a) => a.action), ['service_key.created', 'service_key.revoked']);
  assert.ok(findEndpoint('GET', '/players/abc') && !findEndpoint('GET', '/players/abc/nope'));
});

test('API: servidor HTTP — /health y /openapi.json públicos, llave por Bearer, 401 y límite de tasa', async () => {
  const { app } = setup();
  const k = app.serviceKeys.create({ id: 'adm', tenant_id: T }, { name: 'Backoffice', scopes: ['players:read'] });
  const srv = createServer(createHandler(app, undefined, { devAuth: false }));
  await new Promise<void>((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const h = await fetch(`${base}/api/v1/health`); assert.equal(h.status, 200); assert.equal((await h.json()).status, 'ok');
    assert.equal((await (await fetch(`${base}/api/v1/openapi.json`)).json()).openapi, '3.1.0');
    assert.equal((await fetch(`${base}/api/v1/players`)).status, 401, 'sin credenciales');
    assert.equal((await fetch(`${base}/api/v1/players`, { headers: { authorization: 'Bearer ss1crm_000000000000_' + '0'.repeat(48) } })).status, 401);
    const ok = await fetch(`${base}/api/v1/players`, { headers: { authorization: `Bearer ${k.key}`, 'x-tenant-id': 'tenant-other', 'x-roles': 'tenant_admin' } });
    assert.equal(ok.status, 200, 'las cabeceras de tenant y rol se ignoran con llave');
    assert.equal((await fetch(`${base}/api/v1/performance`, { headers: { authorization: `Bearer ${k.key}` } })).status, 403);
  } finally { srv.close(); }
  const rl = new RateLimiter(3);
  const t0 = 1_000_000;
  assert.deepEqual([rl.take('k', t0).ok, rl.take('k', t0).ok, rl.take('k', t0).ok, rl.take('k', t0).ok], [true, true, true, false]);
  assert.equal(rl.take('k', t0 + 20_000).ok, true, 'se recarga con el tiempo');
});

test('API: CORS solo para los orígenes del admin (vistas nativas)', async () => {
  const { app } = setup();
  const srv = createServer(createHandler(app, undefined, { devAuth: false }));
  await new Promise<void>((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const ok = await fetch(`${base}/api/v1/health`, { method: 'OPTIONS', headers: { origin: 'https://admin.syssoft1.com', 'access-control-request-method': 'GET' } });
    assert.equal(ok.status, 204); assert.equal(ok.headers.get('access-control-allow-origin'), 'https://admin.syssoft1.com');
    const evil = await fetch(`${base}/api/v1/health`, { method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } });
    assert.equal(evil.status, 403); assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const get = await fetch(`${base}/api/v1/health`, { headers: { origin: 'https://evil.example.com' } });
    assert.equal(get.headers.get('access-control-allow-origin'), null, 'sin cabecera para orígenes no permitidos');
  } finally { srv.close(); }
});

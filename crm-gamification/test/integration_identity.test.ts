import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Ss1IdentityProvider, extractProfile } from '../src/integration/ss1Identity.ts';
import { createHandler } from '../src/api/server.ts';
import { createApp, seedTenant } from '../src/app.ts';
import { ManualClock } from '../src/shared/util.ts';

const GOOD = 'good-token-' + 'a'.repeat(30);
const OTHER = 'other-tenant-' + 'b'.repeat(30);
function fakeApi() {
  const seen: string[] = [];
  const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
    const auth = init.headers.authorization;
    seen.push(auth);
    if (auth === `Bearer ${GOOD}`) return new Response(JSON.stringify({ data: { user: { id: 42, name: 'Ana', client: { slug: 'rumbawin' } }, abilities: [{ action: ['create', 'read'], subject: 'crm' }] } }), { status: 200 });
    if (auth === `Bearer ${OTHER}`) return new Response(JSON.stringify({ user: { id: 7, client_id: 'otro-operador' }, permissions: ['crm.read'] }), { status: 200 });
    if (auth === 'Bearer down-' + 'c'.repeat(20)) return new Response('boom', { status: 500 });
    return new Response(JSON.stringify({ message: 'Unauthenticated.' }), { status: 401 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

test('A2: extracción de perfil con formas comunes', () => {
  assert.deepEqual(extractProfile({ user: { id: 1, client_id: 9 }, abilities: [{ action: 'read', subject: 'crm' }] }), { userId: '1', name: undefined, client: '9', rules: [{ action: 'read', subject: 'crm' }] });
  assert.deepEqual(extractProfile({ data: { me: { id: 'u' }, permissions: ['kyc.update'] } })!.rules, [{ subject: 'kyc', action: 'update' }]);
  assert.equal(extractProfile({ foo: 1 }), null);
  assert.equal(extractProfile(null), null);
});

test('A2: valida token, mapea operador y roles, cachea sin guardar el token y rechaza tenant ajeno', async () => {
  const { fetchImpl, seen } = fakeApi();
  const idp = new Ss1IdentityProvider({ apiBase: 'https://api.test', fetchImpl, tenantMap: { rumbawin: 'tenant-rumbawin' } });
  const r = await idp.resolve(`Bearer ${GOOD}`, 'tenant-rumbawin');
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.actor, { id: 'ss1:42', tenant_id: 'tenant-rumbawin', roles: ['crm_analyst', 'support', 'auditor'] });
  await idp.resolve(`Bearer ${GOOD}`, undefined);
  assert.equal(idp.calls, 1, 'segunda llamada sale de caché');
  assert.deepEqual(await idp.resolve(`Bearer ${GOOD}`, 'tenant-other'), { ok: false, status: 403, error: 'tenant_mismatch' });
  assert.deepEqual(await idp.resolve('Bearer nope-' + 'z'.repeat(20), undefined), { ok: false, status: 401, error: 'invalid_token' });
  assert.deepEqual(await idp.resolve(undefined, undefined), { ok: false, status: 401, error: 'missing_token' });
  assert.deepEqual(await idp.resolve('Bearer down-' + 'c'.repeat(20), undefined), { ok: false, status: 502, error: 'identity_unavailable' });
  const o = await idp.resolve(`Bearer ${OTHER}`, undefined);
  assert.ok(o.ok && o.actor.tenant_id === 'otro-operador' && o.actor.roles.includes('auditor'));
  assert.ok(seen.every((h) => h.startsWith('Bearer ')));
});

test('A2: el servidor decide roles; sin token ni modo desarrollo responde 401', async () => {
  const app = createApp(new ManualClock('2026-11-15T15:00:00Z'));
  seedTenant(app, 'tenant-rumbawin');
  const { fetchImpl } = fakeApi();
  const identity = new Ss1IdentityProvider({ apiBase: 'https://api.test', fetchImpl, tenantMap: { rumbawin: 'tenant-rumbawin' } });
  const srv = createServer(createHandler(app, undefined, { identity, devAuth: false })).listen(0);
  const port = (srv.address() as { port: number }).port;
  const call = (path: string, headers: Record<string, string>, method = 'GET') => fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers });
  try {
    assert.equal((await call('/session', { 'x-roles': 'tenant_admin' })).status, 401, 'sin token no hay cabeceras de desarrollo');
    const s = await (await call('/session', { authorization: `Bearer ${GOOD}`, 'x-roles': 'tenant_admin,approver' })).json() as { actor: { id: string; roles: string[] } };
    assert.equal(s.actor.id, 'ss1:42');
    assert.deepEqual(s.actor.roles, ['crm_analyst', 'support', 'auditor'], 'x-roles del navegador se ignora');
    assert.equal((await call('/runtime/pause', { authorization: `Bearer ${GOOD}` }, 'POST')).status, 403);
    assert.equal((await call('/control-tower', { authorization: 'Bearer bad-' + 'x'.repeat(20) })).status, 401);
    assert.equal((await call('/control-tower', { authorization: `Bearer ${GOOD}`, 'x-tenant-id': 'tenant-otro' })).status, 403);
  } finally { srv.close(); }
});

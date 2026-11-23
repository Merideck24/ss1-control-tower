import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, deriveBrandTokens, normalizeHex, parseThemeConfig } from '../src/integration/theme.ts';
import { route } from '../src/api/router.ts';
import { setup, T } from './helpers.ts';

test('A5: normalización de color y lectura del theme-config', () => {
  assert.equal(normalizeHex('#ABC'), '#aabbcc');
  assert.equal(normalizeHex('7367F0'), '#7367f0');
  assert.equal(normalizeHex('rgb(213, 160, 33)'), '#d5a021');
  assert.equal(normalizeHex('red'), null);
  assert.deepEqual(parseThemeConfig({ data: { primary_color: '#00CFE8', logo_url: 'https://syssoft1.sfo3.digitaloceanspaces.com/x.webp' } }), { primary: '#00cfe8', logo: 'https://syssoft1.sfo3.digitaloceanspaces.com/x.webp' });
  assert.deepEqual(parseThemeConfig({ theme: { colors: { primary: '#28c76f' } }, logo: 'https://evil.example.com/x.png' }), { primary: '#28c76f' });
  assert.deepEqual(parseThemeConfig({ logo: 'http://syssoft1.sfo3.digitaloceanspaces.com/x.png' }), {});
  assert.deepEqual(parseThemeConfig(null), {});
});

test('A5: tokens de marca con contraste garantizado', () => {
  const ok = deriveBrandTokens('#00cfe8');
  assert.equal(ok.source, 'tenant'); assert.equal(ok.brand, '#00cfe8'); assert.equal(ok.brandInk, '#000000');
  const dark = deriveBrandTokens('#1a1a5e');
  assert.equal(dark.source, 'default'); assert.equal(dark.brand, '#d5a021'); assert.match(dark.note!, /poco contraste/);
  assert.equal(deriveBrandTokens(undefined).brand, '#d5a021');
  assert.ok(contrast('#d5a021', '#111111') > 7);
  for (const c of ['#7367f0', '#ea5455', '#28c76f']) { const t = deriveBrandTokens(c); if (t.source === 'tenant') assert.ok(contrast(t.brand, t.brandInk) >= 3); }
});

test('A5: endpoint de tema con integración, caché y modo sin integración', async () => {
  const { app } = setup();
  let calls = 0;
  const fetchImpl = (async () => { calls++; return Response.json({ data: { primaryColor: '#28C76F' } }); }) as unknown as typeof fetch;
  const call = (ss1: boolean) => route(app, { method: 'GET', path: '/integration/ss1/theme', query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': 'support' }, body: {} }, ss1 ? { ss1: { apiBase: 'https://api.test', token: 't'.repeat(20), fetchImpl } } : {});
  assert.equal((await call(false)).status, 409);
  const r = await call(true);
  assert.equal((r.body as { brand: string }).brand, '#28c76f');
  await call(true);
  assert.equal(calls, 1, 'segunda lectura desde caché');
});

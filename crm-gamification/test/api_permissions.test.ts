import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, onboard, T } from './helpers.ts';
import { route } from '../src/api/router.ts';

const call = (app: ReturnType<typeof setup>['app'], method: string, path: string, roles: string, body: Record<string, unknown> = {}, tenant = T) =>
  route(app, { method, path, query: new URLSearchParams(), headers: { 'x-tenant-id': tenant, 'x-roles': roles, 'x-actor': `${roles}@ss1` }, body });

test('API: RBAC por acción', async () => {
  const { app, clock } = setup();
  onboard(app, clock, 'p');
  assert.equal((await call(app, 'POST', '/runtime/pause', 'crm_analyst', { paused: true })).status, 403);
  assert.equal((await call(app, 'POST', '/runtime/pause', 'rg_officer', { paused: true })).status, 200);
  assert.equal((await call(app, 'GET', '/audit', 'crm_analyst')).status, 403);
  assert.equal((await call(app, 'GET', '/audit', 'auditor')).status, 200);
  assert.equal((await call(app, 'POST', '/journeys/j1_verification/approve', 'crm_analyst')).status, 403);
  assert.equal((await call(app, 'POST', '/segments/preview', 'support', { rules: { field: 'kyc', op: 'eq', value: 'verified' } })).status, 403);
  const s = await call(app, 'GET', '/session', 'support');
  assert.deepEqual((s.body as { copilot_tools: string[] }).copilot_tools, []);
});

test('API: tenant desconocido y evento de otro tenant se rechazan', async () => {
  const { app } = setup();
  assert.equal((await call(app, 'GET', '/control-tower', 'crm_analyst', {}, 'tenant-x')).status, 403);
  assert.equal((await call(app, 'POST', '/events', 'crm_analyst', { tenant_id: 'tenant-other' })).status, 403);
  const ask = await call(app, 'POST', '/copilot/ask', 'crm_analyst', { question: 'hola' });
  assert.equal((ask.body as { stop_reason: string }).stop_reason, 'not_configured');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abilitiesToRoles, isEmbedSession } from '../src/integration/ss1Auth.ts';

test('A1: permisos CASL del admin → roles del CRM', () => {
  assert.deepEqual(abilitiesToRoles([{ action: 'manage', subject: 'all' }]).sort(), ['approver', 'auditor', 'crm_analyst', 'rg_officer', 'support', 'tenant_admin']);
  assert.deepEqual(abilitiesToRoles([{ action: ['create', 'read'], subject: 'crm' }]).sort(), ['auditor', 'crm_analyst', 'support']);
  assert.deepEqual(abilitiesToRoles([{ action: 'read', subject: 'audit-log' }]), ['auditor']);
  assert.deepEqual(abilitiesToRoles([{ action: 'update', subject: 'kyc' }]), ['rg_officer']);
  assert.deepEqual(abilitiesToRoles([{ action: 'manage', subject: 'all' }, { action: 'manage', subject: 'all', inverted: true }]), []);
  assert.deepEqual(abilitiesToRoles([{ action: 'read', subject: 'games' }]), []);
});

test('A1: validación del mensaje de sesión', () => {
  const ok = { type: 'ss1-crm:session', version: 1, accessToken: 'x'.repeat(40), tenantId: 'tenant-rumbawin', user: { id: '7' }, abilities: [] };
  assert.ok(isEmbedSession(ok));
  assert.ok(!isEmbedSession({ ...ok, version: 2 }));
  assert.ok(!isEmbedSession({ ...ok, accessToken: 'short' }));
  assert.ok(!isEmbedSession({ ...ok, tenantId: '../etc' }));
  assert.ok(!isEmbedSession({ ...ok, abilities: 'all' }));
  assert.ok(!isEmbedSession(null));
});

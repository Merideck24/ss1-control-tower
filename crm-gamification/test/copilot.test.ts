import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, onboard, T } from './helpers.ts';
import type { CopilotSession } from '../src/copilot/tools.ts';

const S: CopilotSession = { tenant_id: T, operator_id: 'ana', roles: ['crm_analyst'] };
const draft = { id: 'cp_draft', purpose: 'marketing', trigger: { event_type: 'deposit.settled' }, entry: 'm', nodes: [{ id: 'm', type: 'message', channel: 'inapp', template: 'loyalty_halfway', next: 'e' }, { id: 'e', type: 'exit' }] };

test('Copiloto: sin herramientas para enviar/publicar/otorgar; solo escribe borradores', () => {
  const { app } = setup();
  for (const name of ['send_message', 'publish_journey', 'grant_reward', 'set_rg_status']) assert.equal(app.copilot.call(S, name, {}).ok, false);
  const saved = app.copilot.call(S, 'save_draft', { journey: draft });
  assert.ok(saved.ok);
  assert.equal(app.registry.list(T).find((j) => j.id === 'cp_draft')!.status, 'draft');
  assert.equal(app.registry.live(T).some((j) => j.id === 'cp_draft'), false);
});

test('Copiloto: intento de salto entre tenants y permisos insuficientes', () => {
  const { app, clock } = setup();
  onboard(app, clock, 'other', 'tenant-other');
  assert.equal(app.copilot.call(S, 'preview_segment', { rules: { field: 'kyc', op: 'eq', value: 'verified' }, tenant_id: 'tenant-other' }).ok, false);
  assert.equal(app.copilot.call(S, 'save_draft', { journey: { ...draft, tenant_id: 'tenant-other' } }).ok, false);
  const auditor: CopilotSession = { ...S, roles: ['auditor'] };
  assert.equal((app.copilot.call(auditor, 'save_draft', { journey: draft }) as { error: string }).error, 'insufficient_role');
  assert.deepEqual(app.copilot.definitionsFor(auditor).map((t) => t.name), ['query_metric']);
});

test('Copiloto: métricas agregadas con k-anonimato y fecha de datos', () => {
  const { app, clock } = setup();
  onboard(app, clock, 'p1'); onboard(app, clock, 'p2');
  const r = app.copilot.call(S, 'query_metric', { metric: 'kyc_verified_rate' });
  assert.ok(r.ok); assert.equal((r.data as { value: unknown }).value, 'insufficient_data'); assert.ok(r.data_as_of);
  for (let i = 3; i < 8; i++) onboard(app, clock, `p${i}`);
  const r2 = app.copilot.call(S, 'query_metric', { metric: 'kyc_verified_rate' });
  assert.equal((r2 as { data: { value: number } }).data.value, 1);
  const seg = app.copilot.call(S, 'preview_segment', { rules: { field: 'kyc', op: 'eq', value: 'verified' } });
  assert.ok(!JSON.stringify(seg).includes('p3'));
});

test('Copiloto: simulación y validación de política sin efectos', () => {
  const { app } = setup();
  const sim = app.copilot.call(S, 'simulate_journey', { journey: draft, synthetic_profile: { rg: 'self_excluded' } });
  assert.ok(sim.ok);
  assert.ok(JSON.stringify(sim.data).includes('rg_restricted:self_excluded'));
  const v = app.copilot.call(S, 'validate_policy', { journey: { ...draft, purpose: 'service', nodes: [{ id: 'm', type: 'grant_reward', reward_id: 'x', next: 'e' }, { id: 'e', type: 'exit' }] } });
  assert.ok((v as { data: { errors: string[] } }).data.errors.includes('service_journey_cannot_grant_incentives'));
});

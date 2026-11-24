import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, onboard, T } from './helpers.ts';
import { route } from '../src/api/router.ts';
import { DEFAULT_POLICY } from '../src/policy/policyEngine.ts';
import { diffPolicy, validatePolicy } from '../src/policy/governance.ts';

const { version: _v, ...BASE } = DEFAULT_POLICY;
const call = (app: ReturnType<typeof setup>['app'], method: string, path: string, roles: string, actor: string, body: Record<string, unknown> = {}) =>
  route(app, { method, path, query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': roles, 'x-actor': actor }, body });

test('I3: validación de límites y detección de cambios que relajan protecciones', () => {
  assert.deepEqual(validatePolicy({ ...BASE }), []);
  const bad = validatePolicy({ ...BASE, market: 'col', max_marketing_per_day: 2, max_marketing_per_day_by_channel: { sms: 3 }, max_marketing_per_week: 1, quiet_hours: { start: 18, end: 12 }, rg_feed_max_staleness_ms: 60_000 });
  assert.equal(bad.length, 5, bad.join(' | '));
  const loose = diffPolicy(DEFAULT_POLICY, { ...DEFAULT_POLICY, max_marketing_per_day: 3, quiet_hours: { start: 23, end: 7 }, require_kyc_for_incentives: false, max_marketing_per_day_by_channel: { ...DEFAULT_POLICY.max_marketing_per_day_by_channel, sms: 0 } });
  const by = Object.fromEntries(loose.map((c) => [c.field, c.loosens]));
  assert.deepEqual(by, { max_marketing_per_day: true, quiet_hours: true, require_kyc_for_incentives: true, 'max_marketing_per_day_by_channel.sms': false }, 'bajar un tope endurece; subirlo o acortar el silencio relaja');
});

test('I3: propuesta → aprobación por otra persona → se aplica y las decisiones usan la nueva versión', async () => {
  const { app, clock } = setup();
  onboard(app, clock, 'p');
  const tighter = { ...BASE, max_marketing_per_day: 1, max_marketing_per_day_by_channel: { inapp: 1, email: 1, webpush: 1, sms: 1, whatsapp: 1, telegram: 0 } };
  assert.equal((await call(app, 'POST', '/policies/proposals', 'crm_analyst', 'ana', { policy: tighter })).status, 403, 'marketing no propone límites');
  const r = await call(app, 'POST', '/policies/proposals', 'rg_officer', 'jr@ss1', { policy: tighter });
  assert.equal(r.status, 201);
  const prop = r.body as { id: string; changes: { field: string; loosens: boolean }[]; base_version: string };
  assert.equal(prop.base_version, DEFAULT_POLICY.version);
  assert.ok(prop.changes.every((c) => !c.loosens), 'endurecer no exige justificación');
  assert.equal(app.policy.decide({ profile: app.ingestor.get(T, 'p')!, purpose: 'marketing', channel: 'inapp' }).policy_version, DEFAULT_POLICY.version, 'sin aprobar, nada cambia');
  assert.equal((await call(app, 'POST', `/policies/proposals/${prop.id}/approve`, 'approver', 'jr@ss1')).status, 403, 'quien propone no aprueba');
  assert.equal((await call(app, 'POST', `/policies/proposals/${prop.id}/approve`, 'approver', 'compliance@ss1')).status, 200);
  const d = app.policy.decide({ profile: app.ingestor.get(T, 'p')!, purpose: 'marketing', channel: 'telegram' });
  assert.match(d.policy_version, /^co-rumbawin-/); assert.notEqual(d.policy_version, DEFAULT_POLICY.version);
  assert.ok(d.reasons.includes('frequency_cap_channel:telegram') || d.reasons.some((x) => x.startsWith('no_marketing_consent')));
  const list = (await call(app, 'GET', '/policies', 'auditor', 'aud')).body as { policies: { market: string; version: string; history: unknown[] }[] };
  assert.equal(list.policies[0].history.length, 1);
  assert.deepEqual(app.audit.list(T).filter((a) => a.action.startsWith('policy.')).map((a) => a.action), ['policy.proposed', 'policy.approved']);
});

test('I3: relajar exige justificación; propuestas obsoletas no pisan otra versión; mercado nuevo', async () => {
  const { app } = setup();
  const looser = { ...BASE, max_marketing_per_day: 4, max_marketing_per_week: 10 };
  const noWhy = await call(app, 'POST', '/policies/proposals', 'tenant_admin', 'adm', { policy: looser });
  assert.equal(noWhy.status, 422);
  assert.match((noWhy.body as { message: string }).message, /relaja una protección/);
  const a = (await call(app, 'POST', '/policies/proposals', 'tenant_admin', 'adm', { policy: looser, justification: 'Resolución Coljuegos 2026: tope de 4 mensajes promocionales al día' })).body as { id: string; changes: { loosens: boolean }[] };
  assert.ok(a.changes.some((c) => c.loosens));
  const b = (await call(app, 'POST', '/policies/proposals', 'rg_officer', 'jr', { policy: { ...BASE, quiet_hours: { start: 21, end: 9 } } })).body as { id: string };
  assert.equal((await call(app, 'POST', `/policies/proposals/${b.id}/approve`, 'approver', 'apr')).status, 200);
  const stale = await call(app, 'POST', `/policies/proposals/${a.id}/approve`, 'approver', 'apr');
  assert.equal(stale.status, 422); assert.match((stale.body as { message: string }).message, /Se aprobó otra versión/);
  assert.equal(app.governance.proposals(T).find((p) => p.id === a.id)!.status, 'superseded');
  assert.equal(app.policy.listPolicies(T)[0].quiet_hours.start, 21);
  // mercado nuevo
  const pe = (await call(app, 'POST', '/policies/proposals', 'tenant_admin', 'adm', { policy: { ...BASE, market: 'PE', max_marketing_per_day: 1, max_marketing_per_day_by_channel: { inapp: 1 } } })).body as { id: string; base_version: null };
  assert.equal(pe.base_version, null);
  assert.equal((await call(app, 'POST', `/policies/proposals/${pe.id}/reject`, 'approver', 'apr', { reason: '' })).status, 422);
  assert.equal((await call(app, 'POST', `/policies/proposals/${pe.id}/approve`, 'approver', 'apr')).status, 200);
  assert.deepEqual(app.policy.listPolicies(T).map((p) => p.market).sort(), ['CO', 'PE']);
});

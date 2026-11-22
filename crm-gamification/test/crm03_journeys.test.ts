import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, onboard, ev, T } from './helpers.ts';
import { simulateJourney } from '../src/journeys/runtime.ts';
import { validateJourney } from '../src/journeys/model.ts';
import { DAY } from '../src/shared/util.ts';

test('CRM-03 / recorrido 1: recordatorio de verificación tras 24 h y salida al verificar', () => {
  const { app, clock } = setup();
  onboard(app, clock, 'pending', T, { verify: false });
  onboard(app, clock, 'verifies', T, { verify: false });
  app.ingestor.ingest(ev(T, 'verifies', 'player.verified', { kyc_status: 'verified' }, clock.now().toISOString()));
  clock.advance(DAY + 1000);
  app.runtime.runDue();
  const sent = app.channels.receipts(T).filter((r) => r.template === 'verify_reminder');
  assert.deepEqual(sent.map((r) => [r.player_id, r.status]), [['pending', 'accepted']]);
  const exited = app.runtime.instances(T, { player_id: 'verifies', journey_id: 'j1_verification' })[0];
  assert.equal(exited.status, 'exited');
});

test('CRM-03: versión publicada queda fija para sus instancias y es inmutable', () => {
  const { app, clock } = setup();
  const published = app.registry.get(T, 'j1_verification', 1)!;
  assert.throws(() => { (published.nodes as unknown[]).push({}); });
  onboard(app, clock, 'p', T, { verify: false });
  // nueva versión en borrador no afecta a la instancia viva
  const analyst = { id: 'analyst@ss1', tenant_id: T, roles: ['crm_analyst' as const] };
  const { version: _v, status: _s, created_by: _c, updated_at: _u, tenant_id: _t, approved_by: _a, approval_signature: _g, ...rest } = published;
  const v2 = app.registry.saveDraft(analyst, { ...structuredClone(rest), nodes: rest.nodes.map((n) => (n.type === 'wait' ? { ...n, duration_ms: 1000 } : n)) });
  assert.equal(v2.version, 2);
  const inst = app.runtime.instances(T, { player_id: 'p', journey_id: 'j1_verification' })[0];
  assert.equal(inst.version, 1);
});

test('CRM-03: aprobación separada y firma sobre la versión', () => {
  const { app } = setup();
  const analyst = { id: 'ana', tenant_id: T, roles: ['crm_analyst' as const, 'approver' as const] };
  app.registry.saveDraft(analyst, { id: 'jt', brand_id: 'rumbawin', name: 't', purpose: 'marketing', trigger: { event_type: 'deposit.settled' }, entry: 'g', nodes: [{ id: 'g', type: 'grant_reward', reward_id: 'welcome_fs_10', next: 'e' }, { id: 'e', type: 'exit' }] });
  assert.throws(() => app.registry.publish(analyst, 'jt'), /not_approved|approved/);
  app.registry.submit(analyst, 'jt');
  assert.throws(() => app.registry.approve(analyst, 'jt'), /author cannot approve/);
  const j = app.registry.approve({ id: 'boss', tenant_id: T, roles: ['approver'] }, 'jt');
  assert.ok(j.approval_signature);
  assert.equal(app.registry.publish(analyst, 'jt').status, 'published');
});

test('CRM-03: validación de grafo y simulación sin efectos', () => {
  const { app, clock } = setup();
  assert.ok(validateJourney({ entry: 'a', purpose: 'service', nodes: [{ id: 'a', type: 'wait', duration_ms: 1, next: 'zz' }] }).includes('dangling_edge:a->zz'));
  assert.ok(validateJourney({ entry: 'a', purpose: 'service', nodes: [{ id: 'a', type: 'grant_reward', reward_id: 'x', next: 'e' }, { id: 'e', type: 'exit' }] }).includes('service_journey_cannot_grant_incentives'));
  onboard(app, clock, 'sim');
  const def = app.registry.get(T, 'j1_verification', 1)!;
  const before = app.channels.receipts(T).length;
  const r = simulateJourney(def, { ...app.ingestor.get(T, 'sim')!, kyc: { value: 'pending', source: 's', occurred_at: clock.now().toISOString(), event_id: 'x', version: 1 } }, ev(T, 'sim', 'player.registered', { email_masked: '', country: 'CO', locale: 'es', timezone: 'America/Bogota' }, clock.now().toISOString()), { policy: app.policy, audit: app.audit, clock });
  assert.equal(r.status, 'completed');
  assert.ok(r.trace.some((s) => s.outcome === 'simulated_send'));
  assert.equal(app.channels.receipts(T).length, before);
});

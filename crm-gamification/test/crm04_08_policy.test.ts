import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, onboard, ev, T } from './helpers.ts';
import { HOUR } from '../src/shared/util.ts';

test('CRM-04: consentimiento, canal, frecuencia y horario silencioso por propósito', () => {
  const { app, clock } = setup();
  onboard(app, clock, 'p', T, { email: false });
  const p = () => app.ingestor.get(T, 'p')!;
  assert.deepEqual(app.policy.decide({ profile: p(), purpose: 'marketing', channel: 'email' }).reasons, ['no_marketing_consent:email']);
  assert.equal(app.policy.decide({ profile: p(), purpose: 'service', channel: 'email' }).kind, 'allow');
  assert.equal(app.policy.decide({ profile: p(), purpose: 'marketing', channel: 'inapp' }).kind, 'allow');
  app.policy.recordMarketingSend(p()); app.policy.recordMarketingSend(p());
  assert.ok(app.policy.decide({ profile: p(), purpose: 'marketing', channel: 'inapp' }).reasons.includes('frequency_cap'));
  // 23:00 Bogotá = 04:00Z
  clock.set('2026-11-17T04:00:00Z');
  app.policy.markRgFeedSynced(T);
  app.ingestor.ingest(ev(T, 'p', 'consent.changed', { purpose: 'marketing', channel: 'email', granted: true }, clock.now().toISOString()));
  const d = app.policy.decide({ profile: p(), purpose: 'marketing', channel: 'email' });
  assert.equal(d.kind, 'defer');
  assert.equal(new Date(d.defer_until!).toISOString(), '2026-11-17T13:00:00.000Z'); // 08:00 Bogotá
});

test('CRM-04: fallo de proveedor queda trazado con estado y razón; reintento no duplica', () => {
  const { app, clock } = setup();
  onboard(app, clock, 'p');
  app.adapters.email.failNext = 5;
  const r = app.channels.send({ tenant_id: T, player_id: 'p', address: 'x', channel: 'email', template: 'verify_reminder', locale: 'es', vars: {}, idempotency_key: 'k1' });
  assert.equal(r.status, 'failed'); assert.equal(r.reason, 'provider_unavailable'); assert.equal(r.attempts, 3);
  app.adapters.email.failNext = 0;
  assert.equal(app.channels.send({ tenant_id: T, player_id: 'p', address: 'x', channel: 'email', template: 'verify_reminder', locale: 'es', vars: {}, idempotency_key: 'k1' }).attempts, 4);
  app.channels.send({ tenant_id: T, player_id: 'p', address: 'x', channel: 'email', template: 'verify_reminder', locale: 'es', vars: {}, idempotency_key: 'k1' });
  app.channels.send({ tenant_id: T, player_id: 'p', address: 'x', channel: 'email', template: 'verify_reminder', locale: 'es', vars: {}, idempotency_key: 'k1' });
  assert.equal(app.adapters.email.outbox.filter((m) => m.idempotency_key === 'k1').length, 1);
});

test('CRM-08: autoexclusión mientras espera ⇒ promoción bloqueada al revalidar, con motivo y versión', () => {
  const { app, clock } = setup();
  onboard(app, clock, 'p', T, { verify: false });
  const p = app.ingestor.get(T, 'p')!;
  assert.equal(app.policy.decide({ profile: p, purpose: 'marketing', channel: 'inapp' }).kind, 'allow');
  app.ingestor.ingest(ev(T, 'p', 'rg.status_changed', { status: 'self_excluded' }, clock.now().toISOString()));
  const d = app.policy.decide({ profile: app.ingestor.get(T, 'p')!, purpose: 'marketing', channel: 'inapp', incentive: true });
  assert.equal(d.kind, 'suppress');
  assert.ok(d.reasons.includes('rg_restricted:self_excluded'));
  assert.equal(d.policy_version, 'co-rumbawin-2026.11.1');
});

test('CRM-08: estado JR ausente o feed desactualizado ⇒ suprime marketing y alerta (fail-closed)', () => {
  const { app, clock } = setup();
  app.ingestor.ingest(ev(T, 'nr', 'player.registered', { email_masked: 'x', country: 'CO', locale: 'es', timezone: 'America/Bogota' }, clock.now().toISOString()));
  app.ingestor.ingest(ev(T, 'nr', 'consent.changed', { purpose: 'marketing', channel: 'inapp', granted: true }, clock.now().toISOString()));
  const d = app.policy.decide({ profile: app.ingestor.get(T, 'nr')!, purpose: 'marketing', channel: 'inapp' });
  assert.ok(d.reasons.includes('rg_status_missing')); assert.ok(d.alert);
  onboard(app, clock, 'ok');
  clock.advance(7 * HOUR);
  assert.ok(app.policy.decide({ profile: app.ingestor.get(T, 'ok')!, purpose: 'marketing', channel: 'inapp' }).reasons.includes('rg_feed_stale'));
  assert.equal(app.policy.decide({ profile: app.ingestor.get(T, 'ok')!, purpose: 'service', channel: 'inapp' }).kind, 'allow');
});

test('Recorrido 5: cambio JR cancela acciones de marketing pendientes', () => {
  const { app, clock } = setup();
  const analyst = { id: 'ana', tenant_id: T, roles: ['crm_analyst' as const] };
  app.registry.saveDraft(analyst, { id: 'jw', brand_id: 'rumbawin', name: 'winback', purpose: 'marketing', trigger: { event_type: 'deposit.settled' }, entry: 'w', nodes: [{ id: 'w', type: 'wait', duration_ms: HOUR, next: 'm' }, { id: 'm', type: 'message', channel: 'inapp', template: 'deposit_progress', next: 'e' }, { id: 'e', type: 'exit' }] });
  app.registry.submit(analyst, 'jw'); app.registry.approve({ id: 'boss', tenant_id: T, roles: ['approver'] }, 'jw'); app.registry.publish(analyst, 'jw');
  onboard(app, clock, 'p');
  app.ingestor.ingest(ev(T, 'p', 'deposit.settled', { deposit_id: 'd', amount_minor: 1000, currency: 'COP' }, clock.now().toISOString()));
  app.ingestor.ingest(ev(T, 'p', 'rg.status_changed', { status: 'cooling_off' }, clock.now().toISOString()));
  clock.advance(2 * HOUR); app.policy.markRgFeedSynced(T); app.runtime.runDue();
  const inst = app.runtime.instances(T, { player_id: 'p', journey_id: 'jw' })[0];
  assert.equal(inst.status, 'cancelled');
  assert.equal(app.channels.receipts(T, 'p').filter((r) => r.template === 'deposit_progress').length, 0);
});

test('CRM-08: pausa de recorrido y pausa general impiden nuevos efectos; auditoría encadenada', () => {
  const { app, clock } = setup();
  const admin = { id: 'adm', tenant_id: T, roles: ['tenant_admin' as const] };
  app.registry.setPaused(admin, 'j3_reward_notice', true, 'incidente');
  onboard(app, clock, 'p');
  app.ingestor.ingest(ev(T, 'p', 'reward.granted', { grant_id: 'g1', reward_type: 'bonus', value: { amount_minor: 100, currency: 'COP' }, expires_at: '2026-12-01T00:00:00Z' }, clock.now().toISOString(), { source: 'ss1.bonus' }));
  assert.equal(app.runtime.instances(T, { journey_id: 'j3_reward_notice' }).length, 0);
  app.runtime.setGlobalPause(T, true, 'adm', 'pausa general');
  onboard(app, clock, 'q', T, { verify: false });
  assert.equal(app.runtime.instances(T, { player_id: 'q' }).length, 0);
  assert.ok(app.audit.list(T, { action: 'journey.paused' }).length === 1);
  assert.ok(app.audit.verifyChain());
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, onboard, ev, T } from './helpers.ts';
import { seedAcquisitionHistory } from '../src/demoAcquisition.ts';
import { trainPersonas } from '../src/analytics/personas.ts';
import { nextBestAction } from '../src/analytics/nba.ts';
import type { PlayerPrediction } from '../src/analytics/models.ts';
import { runSegment } from '../src/segments/segmentEngine.ts';

const pred = (o: Partial<PlayerPrediction> = {}): PlayerPrediction => ({ churn: null, deposit: null, value_30d_minor: 0, vip_early: false, preferences: { product: null, casino_share: null, daypart: null, avg_stake_minor: null }, promo_eligible: true, ...o });

test('C4: personas deterministas, con IDs estables y nombres legibles', () => {
  const { app } = setup('2026-11-23T15:00:00Z');
  seedAcquisitionHistory(app, T, 90);
  const a = trainPersonas(app.performance.playerFacts(T), app.clock.now());
  const b = trainPersonas(app.performance.playerFacts(T), app.clock.now());
  assert.equal(a.k, 5);
  assert.deepEqual(a.personas.map((p) => [p.id, p.size, p.name]), b.personas.map((p) => [p.id, p.size, p.name]));
  assert.equal(a.personas.reduce((s, p) => s + p.size, 0), a.assignment.size);
  assert.ok(a.personas.every((p) => p.name.length > 3 && p.size > 0));
  assert.deepEqual(a.personas.map((p) => p.id), ['P1', 'P2', 'P3', 'P4', 'P5']);
  assert.equal(trainPersonas([], app.clock.now()).k, 0, 'sin datos suficientes no hay personas');
});

test('E4: juego responsable ⇒ solo «no contactar»; bloqueo por política nunca gana; «no contactar» si nada aporta valor', () => {
  const { app, clock } = setup();
  onboard(app, clock, 'ok');
  const p = app.ingestor.get(T, 'ok')!;
  const rg = nextBestAction(p, pred({ promo_eligible: false, churn: { p: 0.9, reasons: [] }, value_30d_minor: 9e9 }), { lifecycle: 'inactivo', policy: app.policy });
  assert.equal(rg.chosen.action, 'no_contact'); assert.equal(rg.candidates.length, 1); assert.match(rg.note, /juego responsable/);
  const none = nextBestAction(p, pred(), { lifecycle: 'activo', policy: app.policy });
  assert.equal(none.chosen.action, 'no_contact');
  const nudge = nextBestAction(p, pred({ deposit: { p: 0.5, reasons: [] }, value_30d_minor: 1_000_000 }), { lifecycle: 'activo', policy: app.policy });
  assert.equal(nudge.chosen.action, 'deposit_nudge');
  // sin consentimiento in-app ⇒ la candidata queda bloqueada y gana «no contactar»
  app.ingestor.ingest(ev(T, 'ok', 'consent.changed', { purpose: 'marketing', channel: 'inapp', granted: false }, clock.now().toISOString()));
  const blocked = nextBestAction(app.ingestor.get(T, 'ok')!, pred({ deposit: { p: 0.5, reasons: [] }, value_30d_minor: 1_000_000 }), { lifecycle: 'activo', policy: app.policy });
  const c = blocked.candidates.find((x) => x.action === 'deposit_nudge')!;
  assert.equal(c.allowed, false); assert.ok(c.blocked_by!.some((r) => r.startsWith('marketing_consent_revoked')));
  assert.equal(blocked.chosen.action, 'no_contact');
});

test('C4/E4: segmentos por persona y por acción recomendada', () => {
  const { app } = setup('2026-11-23T15:00:00Z');
  seedAcquisitionHistory(app, T, 90);
  const pm = app.personas(T);
  const r = runSegment({ id: 's', tenant_id: T, name: 'p1', version: 1, rules: { field: 'persona', op: 'eq', value: 'P1' } }, app.ingestor.all(T), app.clock.now(), { persona: (id) => pm.assignment.get(id) });
  assert.equal(r.members.length, pm.personas[0].size);
  const n = runSegment({ id: 'n', tenant_id: T, name: 'nba', version: 1, rules: { field: 'nba.action', op: 'eq', value: 'vip_handover' } }, app.ingestor.all(T), app.clock.now(), { nba: (id) => app.nba(T, id)?.chosen.action });
  assert.ok(n.members.length > 0);
  assert.ok(n.members.every((id) => app.models(T).predictions.get(id)!.promo_eligible));
});

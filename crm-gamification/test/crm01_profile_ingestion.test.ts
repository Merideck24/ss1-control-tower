import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, onboard, ev, T } from './helpers.ts';
import { profileView } from '../src/profile/projection.ts';

test('CRM-01: perfil 360 con origen y fecha de cada campo crítico y línea de tiempo ordenada', () => {
  const { app, clock } = setup();
  onboard(app, clock, 'p1');
  const v = profileView(app.ingestor.get(T, 'p1')!);
  assert.equal(v.kyc.value, 'verified');
  assert.equal(v.kyc.source, 'ss1.pam');
  assert.ok(v.kyc.as_of);
  assert.equal(v.rg.source, 'ss1.rg');
  assert.equal(v.contact.email.value, 'a***@mail.com');
  assert.equal(v.consents['marketing:email'].value, true);
  const times = v.timeline.map((t) => t.occurred_at);
  assert.deepEqual(times, [...times].sort());
});

test('Ingesta: eventos duplicados se aplican una vez y fuera de orden no pisan estado más reciente', () => {
  const { app } = setup();
  const reg = ev(T, 'p2', 'player.registered', { email_masked: 'b***@x.co', country: 'CO', locale: 'es', timezone: 'America/Bogota' }, '2026-11-15T10:00:00Z');
  assert.equal(app.ingestor.ingest(reg).status, 'applied');
  assert.equal(app.ingestor.ingest(reg).status, 'duplicate');
  app.ingestor.ingest(ev(T, 'p2', 'rg.status_changed', { status: 'self_excluded' }, '2026-11-15T12:00:00Z'));
  app.ingestor.ingest(ev(T, 'p2', 'rg.status_changed', { status: 'none' }, '2026-11-15T11:00:00Z')); // llega tarde
  assert.equal(app.ingestor.get(T, 'p2')!.rg!.value, 'self_excluded');
  const dep = ev(T, 'p2', 'deposit.settled', { deposit_id: 'd1', amount_minor: 50_000_00, currency: 'COP' }, '2026-11-15T12:10:00Z');
  app.ingestor.ingest(dep); app.ingestor.ingest(dep);
  assert.equal(app.ingestor.get(T, 'p2')!.stats.deposits_minor, 50_000_00);
  app.ingestor.ingest(ev(T, 'p2', 'deposit.reversed', { deposit_id: 'd1', amount_minor: 50_000_00, currency: 'COP' }, '2026-11-15T12:20:00Z'));
  assert.equal(app.ingestor.get(T, 'p2')!.stats.deposits_minor, 0);
});

test('Ingesta: eventos inválidos van a la cola de errores con razón', () => {
  const { app } = setup();
  const bad = { ...ev(T, 'p3', 'deposit.settled', { deposit_id: 'd', amount_minor: 10.5, currency: 'COP' }, '2026-11-15T10:00:00Z') };
  assert.equal(app.ingestor.ingest(bad).status, 'rejected');
  assert.equal(app.ingestor.ingest({ foo: 1 }).status, 'rejected');
  assert.equal(app.ingestor.deadLetters().length, 2);
});

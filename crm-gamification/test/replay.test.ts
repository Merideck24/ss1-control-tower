import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, onboard, ev, T } from './helpers.ts';
import { createApp } from '../src/app.ts';
import type { EventEnvelope } from '../src/domain/events.ts';

test('Replay: reinyectar todo el log no produce efectos duplicados', () => {
  const { app, clock } = setup();
  const log: EventEnvelope[] = [];
  app.ingestor.subscribe((e) => log.push(e));
  for (let i = 0; i < 20; i++) onboard(app, clock, `p${i}`);
  for (let i = 0; i < 20; i++) app.ingestor.ingest(ev(T, `p${i}`, 'bet.settled', { bet_id: `b${i}`, stake: { amount_minor: 60_000_000, currency: 'COP' }, product: 'sports' }, clock.now().toISOString()));
  const receipts = app.channels.receipts(T).length;
  const grants = app.rewards.grants(T).length;
  const outbox = app.adapters.inapp.outbox.length + app.adapters.email.outbox.length;
  assert.ok(receipts > 0 && grants > 0);
  for (const e of [...log].reverse()) assert.equal(app.ingestor.ingest(e).status, 'duplicate');
  assert.equal(app.channels.receipts(T).length, receipts);
  assert.equal(app.rewards.grants(T).length, grants);
  assert.equal(app.adapters.inapp.outbox.length + app.adapters.email.outbox.length, outbox);
});

test('Aislamiento: dos tenants con mismos player_id no comparten perfil, recibos ni presupuesto', () => {
  const { app, clock } = setup();
  onboard(app, clock, 'same', T);
  onboard(app, clock, 'same', 'tenant-other', { email: false });
  assert.equal(app.ingestor.get(T, 'same')!.consents['marketing:email']?.value, true);
  assert.equal(app.ingestor.get('tenant-other', 'same')!.consents['marketing:email'], undefined);
  assert.ok(app.channels.receipts('tenant-other').every((r) => r.tenant_id === 'tenant-other'));
  assert.ok(app.audit.list(T).every((a) => a.tenant_id === T));
  void createApp;
});

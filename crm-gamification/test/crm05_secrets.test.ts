import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ev, T } from './helpers.ts';
import { redact } from '../src/audit/audit.ts';

test('CRM-05: tokens y enlaces secretos quedan fuera de eventos y logs', () => {
  const { app, clock } = setup();
  const bad = ev(T, 'p', 'player.verified', { kyc_status: 'verified', reset_token: 'abc' } as never, clock.now().toISOString());
  const r = app.ingestor.ingest(bad);
  assert.equal(r.status, 'rejected');
  assert.match(r.reason!, /forbidden key/);
  assert.deepEqual(redact({ email: 'a@b.com', nested: { magic_link: 'https://x' }, ok: 1 }), { email: '[REDACTED]', nested: { magic_link: '[REDACTED]' }, ok: 1 });
  const entry = app.audit.record(T, 'x', 'test', 'p', { otp: '123456' });
  assert.equal(entry.details.otp, '[REDACTED]');
  assert.ok(!JSON.stringify(app.ingestor.deadLetters().map((d) => d.reason)).includes('abc'));
});

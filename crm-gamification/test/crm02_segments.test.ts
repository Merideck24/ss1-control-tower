import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, onboard, ev, T } from './helpers.ts';
import { runSegment, type SegmentDefinition } from '../src/segments/segmentEngine.ts';

test('CRM-02: mismo snapshot ⇒ mismo resultado; AND/OR; exclusiones; aislamiento de tenant', () => {
  const { app, clock } = setup();
  for (let i = 0; i < 6; i++) onboard(app, clock, `p${i}`, T, { verify: i % 2 === 0 });
  onboard(app, clock, 'other', 'tenant-other');
  app.ingestor.ingest(ev(T, 'p0', 'deposit.settled', { deposit_id: 'd', amount_minor: 100_000_00, currency: 'COP' }, clock.now().toISOString()));
  app.ingestor.ingest(ev(T, 'p2', 'rg.status_changed', { status: 'self_excluded' }, clock.now().toISOString()));
  const def: SegmentDefinition = {
    id: 'seg1', tenant_id: T, name: 'verificados o depositantes', version: 1,
    rules: { or: [{ field: 'kyc', op: 'eq', value: 'verified' }, { field: 'stats.deposit_count', op: 'gte', value: 1 }] },
    exclusions: { field: 'rg', op: 'neq', value: 'none' },
  };
  const snapshot = structuredClone(app.ingestor.all(T));
  const a = runSegment(def, snapshot, clock.now());
  const b = runSegment(def, [...snapshot].reverse(), clock.now());
  assert.deepEqual(a, b);
  assert.deepEqual(a.members, ['p0', 'p4']);
  assert.deepEqual(a.excluded, ['p2']);
  assert.equal(a.universe, 6);
  assert.ok(!a.members.includes('other'));
});

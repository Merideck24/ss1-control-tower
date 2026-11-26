import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignArm, report } from '../src/experiments/experiments.ts';

test('CRM-09: asignación persistente y proporción aproximada', () => {
  const arms = Array.from({ length: 5000 }, (_, i) => assignArm('t', 'c', `p${i}`, 10));
  assert.deepEqual(arms, Array.from({ length: 5000 }, (_, i) => assignArm('t', 'c', `p${i}`, 10)));
  const pct = arms.filter((a) => a === 'control').length / 50;
  assert.ok(pct > 8 && pct < 12, `control ${pct}%`);
});

test('CRM-09: reporte con denominador, ventana, costo, conversión observada vs incremento estimado', () => {
  const r = report({ campaign: 'c', window: { from: '2026-11-01', to: '2026-11-15' }, primary_metric: 'deposit_7d', treatment: { n: 900, conversions: 180 }, control: { n: 100, conversions: 12 }, cost_minor: 5_000_000, currency: 'COP' });
  assert.equal(r.treatment.n, 900); assert.equal(r.observed_conversion, 0.2);
  assert.ok(Math.abs(r.estimated_lift.absolute! - 0.08) < 1e-9);
  assert.ok(r.estimated_lift.ci95![0] < 0.08 && r.estimated_lift.ci95![1] > 0.08);
  assert.equal(r.estimated_lift.reliable, true);
  assert.equal(report({ ...r, treatment: { n: 20, conversions: 2 }, control: { n: 5, conversions: 0 }, cost_minor: 0, currency: 'COP' }).estimated_lift.reliable, false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auc, brier, features, FEATURES, fitLogit, predictLogit, explain, trainModels } from '../src/analytics/models.ts';
import { setup, T } from './helpers.ts';
import { seedAcquisitionHistory } from '../src/demoAcquisition.ts';
import { runSegment } from '../src/segments/segmentEngine.ts';
import { DAY } from '../src/shared/util.ts';

test('E: AUC por rangos con empates y Brier', () => {
  assert.equal(auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1]), 0.75);
  assert.equal(auc([0.5, 0.5], [0, 1]), 0.5);
  assert.equal(auc([0.2, 0.3], [1, 1]), null);
  assert.equal(brier([1, 0], [1, 0]), 0);
});

test('E: la regresión logística aprende una relación conocida y explica sus contribuciones', () => {
  const rows = Array.from({ length: 300 }, (_, i) => { const x = FEATURES.map((_f, j) => (j === 0 ? (i % 30) : (i * 7919 + j * 104729) % 13)); return { x, y: x[0] > 15 ? 1 : 0, id: String(i) }; });
  const m = fitLogit(rows);
  const p = rows.map((r) => predictLogit(m, r.x));
  assert.ok(auc(p, rows.map((r) => r.y))! > 0.95);
  assert.equal(explain(m, rows[29].x)[0].feature, 'recency_days');
});

test('E: variables en un punto del tiempo sin fuga de información futura', () => {
  const t = Date.parse('2026-10-01T00:00:00Z');
  const f = { tenant_id: T, player_id: 'p', registered_at: t - 40 * DAY, campaign_id: 'organic', channel: 'organic', ftd_at: t - 35 * DAY,
    deposits: new Map([['d1', { at: t - 35 * DAY, amount: 100_000 }], ['d2', { at: t - 5 * DAY, amount: 50_000 }], ['dfut', { at: t + 5 * DAY, amount: 9_999_999 }]]),
    reversed: new Map(), bets: [{ at: t - 2 * DAY, stake: 10_000, win: 0 }, { at: t + 1 * DAY, stake: 999_999, win: 0 }], bonuses: [], activity: [] };
  const x = features(f as never, t)!;
  assert.equal(x.deposits_30d, 1);
  assert.equal(Math.round(x.recency_days), 2);
  assert.equal(x.bets_14d, 1);
  assert.equal(features({ ...f, registered_at: t + DAY } as never, t), null);
});

test('E1–E3, E5: validación temporal supera la base; juego responsable fuera del modelo', () => {
  const { app } = setup('2026-11-23T15:00:00Z');
  seedAcquisitionHistory(app, T, 90);
  const m = trainModels(app.performance.playerFacts(T), app.clock.now(), { taxRate: 0.15 });
  for (const r of m.models) {
    assert.ok(r.usable, `${r.name} con muestra suficiente`);
    assert.ok(r.validation.auc! >= 0.7, `${r.name} AUC ${r.validation.auc}`);
    assert.ok(r.validation.auc! > r.validation.baseline_auc!, `${r.name} supera la base`);
    assert.ok(!r.coefficients.some((c) => /rg|restric|exclu/i.test(c.feature)));
  }
  assert.ok(m.value.validation.mae_minor! < m.value.validation.baseline_mae_minor!);
  const restricted = app.performance.playerFacts(T).filter((f) => f.rg_restricted);
  assert.ok(restricted.length > 0);
  assert.ok(restricted.every((f) => m.predictions.get(f.player_id)!.promo_eligible === false));
  const someone = [...m.predictions.values()].find((p) => p.churn)!;
  assert.equal(someone.churn!.reasons.length, 3);
  assert.ok(['casino', 'sports', 'mixto', null].includes(someone.preferences.product));
});

test('C5: segmentos por predicciones (VIP temprano y riesgo de abandono)', () => {
  const { app } = setup('2026-11-23T15:00:00Z');
  seedAcquisitionHistory(app, T, 90);
  const preds = app.models(T).predictions;
  const r = runSegment({ id: 's', tenant_id: T, name: 'vip', version: 1, rules: { field: 'pred.vip', op: 'eq', value: true } }, app.ingestor.all(T), app.clock.now(), { predict: (id) => preds.get(id) });
  assert.equal(r.members.length, [...preds.values()].filter((p) => p.vip_early).length);
  const hi = runSegment({ id: 's2', tenant_id: T, name: 'churn', version: 1, rules: { field: 'pred.churn', op: 'gte', value: 0.6 } }, app.ingestor.all(T), app.clock.now(), { predict: (id) => preds.get(id) });
  assert.ok(hi.members.length > 0);
  assert.equal(app.models(T), app.models(T), 'caché por versión de datos');
});

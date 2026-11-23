import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ev, T } from './helpers.ts';
import { DAY } from '../src/shared/util.ts';
import { route } from '../src/api/router.ts';
import { twoProportionZ } from '../src/analytics/kpiAlerts.ts';
import { seedAcquisitionHistory } from '../src/demoAcquisition.ts';

const COP = (n: number) => ({ amount_minor: n, currency: 'COP' });

test('Payback: día de recuperación por cohorte semanal y curva solo con cohortes maduras', () => {
  // lunes 2026-11-02 + 30 días = 2026-12-02 (miércoles)
  const { app } = setup('2026-12-02T12:00:00Z');
  const I = (e: unknown) => assert.notEqual(app.ingestor.ingest(e).status, 'rejected');
  I(ev(T, '', 'marketing.spend_reported', { campaign_id: 'c1', campaign_name: 'C1', channel: 'meta', date: '2026-11-03', impressions: 1000, clicks: 50, spend: COP(100_000) }, '2026-11-03T12:00:00Z'));
  I(ev(T, 'p1', 'player.registered', { email_masked: 'x', country: 'CO', locale: 'es', timezone: 'America/Bogota', acquisition: { campaign_id: 'c1' } }, '2026-11-03T10:00:00Z'));
  I(ev(T, 'p1', 'deposit.settled', { deposit_id: 'd', ...COP(500_000) }, '2026-11-03T11:00:00Z'));
  // NGR por apuesta = 50.000 × (1 − 0,15) = 42.500 → acumulado 85.000 el día 2 y 127.500 el día 5
  for (const [id, at] of [['b1', '2026-11-03T12:00:00Z'], ['b2', '2026-11-05T12:00:00Z'], ['b3', '2026-11-08T12:00:00Z']]) I(ev(T, 'p1', 'bet.settled', { bet_id: id, stake: COP(50_000), win: COP(0), product: 'casino' }, at));
  const pb = app.performance.payback(T, { to: new Date('2026-12-02T12:00:00Z'), weeks: 6 });
  const c = pb.cohorts.find((x) => x.campaign_id === 'c1')!;
  assert.equal(c.week_start, '2026-11-02');
  assert.equal(c.spend_minor, 100_000);
  assert.equal(c.payback_day, 5);
  assert.equal(c.ngr_to_date_minor, 127_500);
  assert.equal(c.recovered_at.d7, 1.275);
  assert.equal(c.recovered_at.d60, null); // cohorte aún sin 60 días
  const curve = pb.curves.find((x) => x.campaign_id === 'c1')!;
  assert.equal(curve.payback_day, 5);
  assert.ok(curve.points.length <= c.age_days + 1);
});

test('Prueba de dos proporciones', () => {
  assert.ok(twoProportionZ(80, 10_000, 120, 10_000) < -1.96);
  assert.ok(Math.abs(twoProportionZ(4, 10, 5, 10)) < 1.96);
  assert.equal(twoProportionZ(1, 0, 1, 10), 0);
});

test('Alertas de KPI: detectan los escenarios de la demo y no alertan sobre ruido', () => {
  const { app } = setup('2026-11-23T15:00:00Z');
  seedAcquisitionHistory(app, T, 90);
  const alerts = app.kpiAlerts(T);
  const has = (rule: string, campaign?: string) => alerts.some((a) => a.rule === rule && (!campaign || a.campaign_id === campaign));
  assert.ok(has('ctr_drop', 'meta_prospecting'));
  assert.ok(has('spend_missing', 'afiliados_cpa'));
  assert.ok(has('rg_share_high', 'tiktok_awareness'));
  assert.ok(has('payback_overdue', 'tiktok_awareness'));
  assert.ok(has('bonus_budget'));
  assert.ok(!alerts.some((a) => a.campaign_id === 'google_search_brand'), 'Google no debería alertar');
  assert.equal(alerts[0].severity, 'critical');
  assert.equal(new Set(alerts.map((a) => a.id)).size, alerts.length);
  assert.ok(alerts.every((a) => a.detail && a.action && a.window));
});

test('Alertas de KPI: reconocer, permisos y configuración validada', async () => {
  const { app } = setup('2026-11-23T15:00:00Z');
  seedAcquisitionHistory(app, T, 90);
  const call = (method: string, path: string, roles: string, body: Record<string, unknown> = {}) => route(app, { method, path, query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': roles, 'x-actor': `${roles}@ss1` }, body });
  assert.equal((await call('GET', '/kpi-alerts', 'support')).status, 403);
  const list = await call('GET', '/kpi-alerts', 'rg_officer');
  assert.equal(list.status, 200);
  const id = (list.body as { alerts: { id: string }[] }).alerts[0].id;
  assert.equal((await call('POST', `/kpi-alerts/${id}/ack`, 'auditor')).status, 403);
  assert.equal((await call('POST', `/kpi-alerts/${id}/ack`, 'crm_analyst', { note: 'Revisado con el equipo de medios' })).status, 200);
  const after = (await call('GET', '/kpi-alerts', 'crm_analyst')).body as { alerts: { id: string; acknowledged?: { by: string } }[] };
  assert.equal(after.alerts.find((a) => a.id === id)!.acknowledged!.by, 'crm_analyst@ss1');
  assert.equal(app.audit.list(T, { action: 'kpi_alert.acknowledged' }).length, 1);
  assert.equal((await call('POST', '/kpi-alerts/no-existe/ack', 'crm_analyst')).status, 404);
  assert.equal((await call('PUT', '/kpi-alerts/config', 'crm_analyst', { ctr_drop_pct: 10 })).status, 403);
  assert.equal((await call('PUT', '/kpi-alerts/config', 'tenant_admin', { ctr_drop_pct: -1 })).status, 422);
  assert.equal((await call('PUT', '/kpi-alerts/config', 'tenant_admin', { unknown: 1 })).status, 422);
  const ok = await call('PUT', '/kpi-alerts/config', 'tenant_admin', { cost_per_ftd_target_minor: 1_000_000_00 });
  assert.equal((ok.body as { cost_per_ftd_target_minor: number }).cost_per_ftd_target_minor, 1_000_000_00);
  assert.ok(!app.kpiAlerts(T).some((a) => a.rule === 'cost_per_ftd_above_target'));
  void DAY;
});

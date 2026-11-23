import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ev, T, T2 } from './helpers.ts';
import { DAY } from '../src/shared/util.ts';
import { route } from '../src/api/router.ts';

const COP = (n: number) => ({ amount_minor: n, currency: 'COP' });

function scenario() {
  const { app, clock } = setup('2026-11-15T15:00:00Z');
  const at = (d: number) => new Date(clock.now().getTime() + d * DAY).toISOString();
  const day = (d: number) => at(d).slice(0, 10);
  const I = (e: unknown) => assert.notEqual(app.ingestor.ingest(e).status, 'rejected');
  const spend = (d: number, imp: number, clk: number, amt: number, tenant = T) =>
    I(ev(tenant, '', 'marketing.spend_reported', { campaign_id: 'meta_a', campaign_name: 'Meta Prospecting', channel: 'meta', date: day(d), impressions: imp, clicks: clk, spend: COP(amt) }, at(d), { source: 'ads.meta' }));
  spend(-40, 9_000, 100, 500_000);
  spend(-40, 10_000, 200, 1_000_000); // reexpresión del mismo día: gana el último
  spend(-2, 10_000, 300, 1_000_000);
  spend(-50, 50_000, 900, 9_999_000); // fuera del período
  spend(-2, 1, 1, 7_777_777, T2); // otro tenant
  const reg = (p: string, d: number, campaign?: string) => I(ev(T, p, 'player.registered', { email_masked: 'x', country: 'CO', locale: 'es', timezone: 'America/Bogota', ...(campaign ? { acquisition: { campaign_id: campaign, channel: 'meta' } } : {}) }, at(d)));
  const dep = (p: string, id: string, d: number, amt: number) => I(ev(T, p, 'deposit.settled', { deposit_id: id, ...COP(amt) }, at(d)));
  const bet = (p: string, id: string, d: number, stake: number, win: number) => I(ev(T, p, 'bet.settled', { bet_id: id, stake: COP(stake), win: COP(win), product: 'casino' }, at(d)));
  ['a1', 'a2', 'a3', 'a4'].forEach((p) => reg(p, -40, 'meta_a'));
  reg('a5', -50, 'meta_a'); // fuera de la cohorte
  reg('o1', -10);
  dep('a1', 'd1', -40, 100_000); bet('a1', 'b1', -39, 50_000, 20_000); bet('a1', 'b2', -5, 10_000, 0);
  I(ev(T, 'a1', 'reward.granted', { grant_id: 'g1', reward_type: 'bonus', value: COP(10_000), expires_at: at(-30) }, at(-39), { source: 'ss1.bonus' }));
  dep('a2', 'd2', -40, 200_000); I(ev(T, 'a2', 'deposit.reversed', { deposit_id: 'd2', ...COP(200_000) }, at(-38))); bet('a2', 'b3', -36, 30_000, 40_000);
  dep('a3', 'd3', -38, 50_000); bet('a3', 'b4', -30, 20_000, 5_000);
  dep('a5', 'd5', -49, 999_999);
  dep('o1', 'd6', -10, 10_000);
  return { app };
}

test('Rendimiento: CTR, FTD %, CPA, costo por FTD, depósitos netos, GGR, NGR y ROI por campaña', () => {
  const { app } = scenario();
  const r = app.performanceReport(T, 45);
  const m = r.campaigns.find((c) => c.campaign_id === 'meta_a')!;
  assert.equal(m.spend_minor, 2_000_000);
  assert.equal(m.impressions, 20_000); assert.equal(m.clicks, 500); assert.equal(m.ctr, 0.025);
  assert.equal(m.registrations, 4); assert.equal(m.ftd, 3); assert.equal(m.ftd_rate, 0.75);
  assert.equal(m.cpa_minor, 500_000); assert.equal(m.cost_per_ftd_minor, 666_667);
  assert.equal(m.deposits_minor, 150_000);
  assert.equal(m.ggr_minor, 45_000);
  assert.equal(m.bonus_cost_minor, 10_000);
  assert.equal(m.gaming_tax_minor, 6_750);
  assert.equal(m.ngr_minor, 28_250); // bonos descontados una sola vez
  assert.equal(m.roi, (28_250 - 2_000_000) / 2_000_000);
  assert.equal(m.ngr_per_ftd_minor, Math.round(28_250 / 3));
});

test('Rendimiento: retención D7/D30 solo sobre FTD maduros', () => {
  const { app } = scenario();
  const m = app.performanceReport(T, 45).campaigns.find((c) => c.campaign_id === 'meta_a')!;
  assert.deepEqual(m.retention_d7, { eligible: 3, retained: 2, rate: 2 / 3 });
  assert.deepEqual(m.retention_d30, { eligible: 3, retained: 1, rate: 1 / 3 });
  // con corte a 20 días: nadie tiene 30 días de antigüedad dentro de la ventana
  const short = app.performanceReport(T, 20);
  assert.equal(short.totals.retention_d30.eligible, 0);
  assert.equal(short.totals.retention_d30.rate, null);
});

test('Rendimiento: orgánico, totales, aislamiento de tenant y enlace con CRM/Loyalty', () => {
  const { app } = scenario();
  const r = app.performanceReport(T, 45);
  const org = r.campaigns.find((c) => c.campaign_id === 'organic')!;
  assert.equal(org.registrations, 1); assert.equal(org.spend_minor, 0); assert.equal(org.roi, null); assert.equal(org.cpa_minor, null);
  assert.equal(r.totals.registrations, 5); assert.equal(r.totals.spend_minor, 2_000_000);
  assert.equal(r.funnel.ftd, 4);
  assert.equal(r.data_quality.unattributed_registrations, 1);
  assert.ok(r.campaigns.at(-1)!.campaign_id === 'organic');
  assert.equal(app.performanceReport(T2, 45).totals.spend_minor, 7_777_777);
  assert.ok(r.totals.crm_reach !== null && r.totals.loyalty_silver_plus !== null);
  assert.ok(r.definitions.roi.includes('no se descuenta dos veces'));
});

test('Rendimiento: permisos y copiloto con k-anonimato', async () => {
  const { app } = scenario();
  const call = (roles: string) => route(app, { method: 'GET', path: '/performance', query: new URLSearchParams('days=45'), headers: { 'x-tenant-id': T, 'x-roles': roles }, body: {} });
  assert.equal((await call('support')).status, 403);
  assert.equal((await call('crm_analyst')).status, 200);
  const c = app.copilot.call({ tenant_id: T, operator_id: 'ana', roles: ['crm_analyst'] }, 'query_metric', { metric: 'campaign_performance', days: 45 });
  assert.ok(c.ok);
  const meta = (c.data as { campaigns: { campaign: string; registrations: unknown; ftd_rate: unknown }[] }).campaigns.find((x) => x.campaign === 'Meta Prospecting')!;
  assert.equal(meta.registrations, '<5');
  assert.equal(meta.ftd_rate, 'insufficient_data');
});

test('Evento de inversión: sin player_id es válido y no crea perfiles', () => {
  const { app } = setup();
  const r = app.ingestor.ingest(ev(T, '', 'marketing.spend_reported', { campaign_id: 'c', campaign_name: 'C', channel: 'google', date: '2026-11-14', impressions: 1, clicks: 1, spend: COP(100) }, '2026-11-14T12:00:00Z'));
  assert.equal(r.status, 'applied');
  assert.equal(app.ingestor.all(T).length, 0);
  assert.equal(app.ingestor.ingest(ev(T, '', 'marketing.spend_reported', { campaign_id: 'c', campaign_name: 'C', channel: 'google', date: '2026-11-14', impressions: 1, clicks: 1, spend: { amount_minor: 1.5, currency: 'COP' } }, '2026-11-14T12:00:00Z')).status, 'rejected');
});

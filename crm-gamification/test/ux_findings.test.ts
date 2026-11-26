/** Hallazgos de la revisión de UX (2026-11-26): pruebas de los arreglos del lado del dominio. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/api/router.ts';
import { missingVars } from '../src/channels/channels.ts';
import { buildVars } from '../src/journeys/vars.ts';
import { report } from '../src/experiments/experiments.ts';
import { localDay } from '../src/analytics/kpiAlerts.ts';
import { seedAcquisitionHistory } from '../src/demoAcquisition.ts';
import { seedDemoOverlap, seedDemoSplit } from '../src/demoAcquisition.ts';
import { setup, onboard, ev, T } from './helpers.ts';

const review = (app: ReturnType<typeof setup>['app'], body: Record<string, unknown>) => route(app, { method: 'POST', path: '/journeys/review', query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': 'crm_analyst', 'x-actor': 'ana@ss1' }, body });

test('#1: nunca se envía un mensaje con variables vacías', () => {
  const { app } = setup();
  const t = app.channels.template(T, 'loyalty_halfway')!;
  assert.deepEqual(missingVars(t, 'es', 'inapp', { player_id: 'p' }).sort(), ['level', 'percent']);
  assert.deepEqual(missingVars(t, 'es', 'inapp', { player_id: 'p', level: 'Oro', percent: 50 }), []);
  const r = app.channels.send({ tenant_id: T, player_id: 'p', address: 'p', channel: 'inapp', template: 'loyalty_halfway', locale: 'es', vars: { player_id: 'p', level: '', percent: 50 }, idempotency_key: 'k1' });
  assert.deepEqual([r.status, r.reason], ['failed', 'template_vars_missing:level']);
  assert.equal(app.adapters.inapp.list(T, 'p').items.length, 0, 'no llega nada a la bandeja');
});

test('#2: cada recorrido de la demo usa una plantilla pensada para él; el constructor avisa si no', async () => {
  const { app } = setup();
  seedDemoOverlap(app, T); seedDemoSplit(app, T);
  const tpl = (id: string) => app.registry.live(T).find((j) => j.id === id)!.nodes.filter((n) => n.type === 'message').map((n) => (n as { template: string }).template);
  assert.deepEqual(tpl('jd_deposit_vip'), ['vip_followup']);
  assert.deepEqual(tpl('jd_deposit_progress'), ['deposit_progress']);
  assert.deepEqual([...new Set(tpl('jab_welcome_message'))], ['welcome_message']);
  const base = { id: 'jx', brand_id: 'rumbawin', name: 'x', purpose: 'marketing', control_group_pct: 10, trigger: { event_type: 'deposit.settled' }, entry: 'm' };
  const bad = (await review(app, { ...base, nodes: [{ id: 'm', type: 'message', channel: 'inapp', template: 'loyalty_halfway', next: 'e' }, { id: 'e', type: 'exit' }] })).body as { valid: boolean; issues: { code: string; message: string }[] };
  const issue = bad.issues.find((i) => i.code === 'template_vars_unavailable')!;
  assert.equal(bad.valid, false); assert.match(issue.message, /\{\{percent\}\}/); assert.match(issue.message, /deposit\.settled/);
  const ok = (await review(app, { ...base, nodes: [{ id: 'm', type: 'message', channel: 'inapp', template: 'deposit_progress', next: 'e' }, { id: 'e', type: 'exit' }] })).body as { issues: { code: string }[] };
  assert.equal(ok.issues.some((i) => i.code === 'template_vars_unavailable'), false);
});

test('#1 #9: depósito y recompensa llegan a la bandeja con textos completos y legibles', () => {
  const { app, clock } = setup();
  seedDemoOverlap(app, T);
  onboard(app, clock, 'p1'); // bienvenida: free spins → aviso de recompensa
  app.ingestor.ingest(ev(T, 'p1', 'deposit.settled', { deposit_id: 'd-1', amount_minor: 50_000_00, currency: 'COP' }, clock.now().toISOString()));
  const box = app.adapters.inapp.list(T, 'p1').items;
  const reward = box.find((m) => m.template === 'reward_granted')!;
  assert.match(reward.body, /^Recibiste giros gratis por \$\s?1\.000\. Puedes usarlos hasta el \d{1,2} de [a-z]+ de 2026\.$/, reward.body);
  for (const m of box) assert.doesNotMatch(`${m.title} ${m.body}`, /\{\{|free_spins|\d{4}-\d{2}-\d{2}|\s[.%]|\.00\b/, `${m.template}: ${m.body}`);
  const v = buildVars('p', ev(T, 'p', 'deposit.settled', { deposit_id: 'x', amount_minor: 20_000_00, currency: 'COP' }, clock.now().toISOString()), 'es');
  assert.match(String(v.amount), /^\$\s?20\.000$/);
});

test('#3: sin grupo de control no se estima incremento', () => {
  const r = report({ campaign: 'j4_loyalty_halfway', window: { from: 'a', to: 'b' }, primary_metric: 'deposit_14d', treatment: { n: 44, conversions: 30 }, control: { n: 0, conversions: 0 }, cost_minor: 0, currency: 'COP' });
  assert.deepEqual([r.estimated_lift.absolute, r.estimated_lift.ci95, r.estimated_lift.reliable], [null, null, false]);
  assert.match(r.estimated_lift.note!, /sin grupo de control/);
});

test('#5: los días se cuentan en hora de Colombia, no en UTC', () => {
  // 25/11 a las 9 p. m. en Bogotá ya es 26/11 en UTC
  const night = new Date('2026-11-26T02:00:00Z');
  assert.equal(night.toISOString().slice(0, 10), '2026-11-26');
  assert.equal(localDay(night), '2026-11-25');
  assert.equal((Date.parse(localDay(night)) - Date.parse('2026-11-22')) / 86_400_000, 3);
});

test('#13: la predicción de la final cierra el domingo que menciona', () => {
  const { app } = setup('2026-11-26T15:00:00Z'); // jueves
  seedAcquisitionHistory(app, T, 20, 1, 7);
  const p = app.store.predictions(T).find((x) => x.id === 'p_final')!;
  const close = new Date(p.closes_at);
  assert.equal(close.toLocaleDateString('es-CO', { weekday: 'long', timeZone: 'America/Bogota' }), 'domingo');
  assert.match(p.question, /final del domingo 29\/11/);
});

test('#10 #12 #15: alertas con nombres y ventanas legibles; la bandeja de la demo tiene aperturas', () => {
  const { app } = setup('2026-11-26T15:00:00Z');
  seedAcquisitionHistory(app, T, 60, 1, 7);
  const alerts = app.kpiAlerts(T);
  const budget = alerts.find((a) => a.rule === 'bonus_budget');
  if (budget) assert.match(budget.title, /Giros gratis de bienvenida/);
  for (const a of alerts) assert.doesNotMatch(`${a.title} ${a.detail}`, /\d{4}-\d{2}-\d{2}|welcome_fs_10/, a.title);
  const cpf = alerts.find((a) => a.rule === 'cost_per_ftd_above_target');
  if (cpf) assert.match(cpf.detail, /últimos 30 días \(sin contar los 2 más recientes/);
  const s = app.adapters.inapp.stats(T);
  assert.ok(s.delivered > 0 && s.read / s.delivered > 0.15 && s.read / s.delivered < 0.6, `aperturas ${s.read}/${s.delivered}`);
  for (const m of app.adapters.inapp.all(T)) if (m.read_at) assert.ok(m.read_at >= m.created_at && Date.parse(m.read_at) <= app.clock.now().getTime(), 'nunca se lee antes de llegar ni en el futuro');
});

test('Demo reproducible: misma fecha ancla ⇒ mismos datos, aunque cambie la hora de carga', async () => {
  const { createApp, seedTenant, withEventSeq } = await import('../src/app.ts');
  const { DemoClock, startOfBogotaDay, useDeterministicIds, useRandomIds } = await import('../src/shared/util.ts');
  const snap = (loadedAt: string) => {
    const anchor = startOfBogotaDay(Date.parse(loadedAt));
    useDeterministicIds(`ss1-demo:${new Date(anchor).toISOString().slice(0, 10)}:${T}`);
    const app = createApp(new DemoClock(anchor), { demoProviders: true });
    withEventSeq(0, () => { seedTenant(app, T); seedAcquisitionHistory(app, T, 30, 0.3, 7); });
    useRandomIds();
    const ps = app.ingestor.all(T).sort((a, b) => a.player_id.localeCompare(b.player_id));
    return JSON.stringify({ n: ps.length, stats: ps.map((p) => [p.player_id, p.stats.deposits_minor, p.stats.stake_minor, p.stats.last_bet_at]), grants: app.rewards.grants(T).map((g) => [g.grant_id, g.player_id, g.status]).sort(), inbox: app.adapters.inapp.stats(T) });
  };
  // 9:00 y 20:30 de Bogotá del mismo día (la segunda ya es «mañana» en UTC)
  assert.equal(snap('2026-11-25T14:00:00Z'), snap('2026-11-26T01:30:00Z'));
  assert.equal(startOfBogotaDay(Date.parse('2026-11-26T01:30:00Z')), Date.parse('2026-11-25T05:00:00Z'));
});

test('Rendimiento sin cambiar resultados: la ventana de latencia sigue siendo de 5.000 eventos', async () => {
  const { app, clock } = setup();
  for (let i = 0; i < 12_000; i++) app.ingestor.ingest(ev(T, `l${i % 50}`, 'consent.changed', { purpose: 'marketing', channel: 'email', granted: true }, clock.now().toISOString()));
  assert.equal(app.ingestor.latency(T).n, 5000);
});

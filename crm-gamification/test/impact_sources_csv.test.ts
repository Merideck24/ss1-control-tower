import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journeyImpact, type Entry } from '../src/analytics/journeyImpact.ts';
import { sourceQuality } from '../src/analytics/affiliates.ts';
import { toCsv, DAY } from '../src/shared/util.ts';
import type { PlayerFacts } from '../src/analytics/performance.ts';
import { setup, T } from './helpers.ts';
import { route } from '../src/api/router.ts';

const NOW = Date.parse('2026-11-20T00:00:00Z');
function fact(id: string, o: { reg?: number; ftd?: boolean; deposits?: number[]; bets?: [number, number, number][]; bonuses?: number[]; campaign?: string } = {}): PlayerFacts {
  const reg = o.reg ?? NOW - 40 * DAY;
  return { tenant_id: T, player_id: id, registered_at: reg, campaign_id: o.campaign ?? 'c1', channel: 'affiliate', ...(o.ftd || o.deposits?.length ? { ftd_at: o.deposits?.[0] ?? reg + 1000 } : {}),
    deposits: new Map((o.deposits ?? []).map((at, i) => [`${id}d${i}`, { at, amount: 100_000 }])), reversed: new Map(), bets: (o.bets ?? []).map(([at, stake, win]) => ({ at, stake, win })),
    bonuses: (o.bonuses ?? []).map((at) => ({ at, amount: 50_000 })), withdrawals: [], instruments: [], activity: [] } as PlayerFacts;
}

test('H4: resultado medido después de entrar — el depósito que dispara no cuenta; el ranking pide control y castiga la incertidumbre', () => {
  const entry = NOW - 20 * DAY;
  const facts = new Map<string, PlayerFacts>();
  const entries: Entry[] = [];
  for (let i = 0; i < 300; i++) {
    const treat = i % 2 === 0;
    const id = `p${i}`;
    // el depósito ocurre justo al entrar (dispara el recorrido); solo el tratamiento vuelve a jugar después
    facts.set(id, fact(id, { deposits: [entry, ...(treat && i % 4 === 0 ? [entry + 2 * DAY] : [])], bets: treat ? [[entry + DAY, 200_000, 100_000], [entry + 8 * DAY, 100_000, 0]] : [[entry + DAY, 100_000, 90_000]] }));
    entries.push({ journey_id: 'j_good', player_id: id, arm: treat ? 'treatment' : 'control', at: entry });
    entries.push({ journey_id: 'j_nocontrol', player_id: id, arm: 'treatment', at: entry });
  }
  entries.push({ journey_id: 'j_good', player_id: 'p0', arm: 'treatment', at: NOW - 2 * DAY }); // aún madurando
  const out = journeyImpact(entries, (p) => facts.get(p), { now: NOW, windowDays: 14, taxRate: 0, costByJourney: (id) => (id === 'j_good' ? 1_000_000 : 0) });
  const g = out.find((x) => x.journey_id === 'j_good')!;
  assert.equal(g.maturing, 1); assert.equal(g.treatment.n, 150); assert.equal(g.control.n, 150);
  assert.equal(g.control.deposit_rate, 0, 'el depósito disparador no es conversión');
  assert.equal(g.treatment.deposit_rate, 0.5);
  assert.equal(g.treatment.ngr_per_player_minor, 200_000); assert.equal(g.control.ngr_per_player_minor, 10_000);
  assert.equal(g.lift.ngr_per_player_minor, 190_000);
  assert.ok(g.lift.reliable && g.roi! > 0);
  assert.equal(g.treatment.active_rate, 1, 'actividad en la segunda semana');
  const n = out.find((x) => x.journey_id === 'j_nocontrol')!;
  assert.equal(n.lift.ngr_per_player_minor, null); assert.match(n.lift.note!, /sin grupo de control/);
  assert.equal(out[0].journey_id, 'j_good', 'sin control va al final del ranking');
});

test('H5: calidad temprana por fuente frente al promedio, con motivos', () => {
  const facts: PlayerFacts[] = [];
  for (let i = 0; i < 40; i++) facts.push(fact(`g${i}`, { campaign: 'good', reg: NOW - 20 * DAY, deposits: [NOW - 19 * DAY], bets: [[NOW - 12 * DAY, 10, 0]] }));
  for (let i = 0; i < 40; i++) facts.push(fact(`b${i}`, { campaign: 'bad', reg: NOW - 20 * DAY, ...(i < 8 ? { deposits: [NOW - 19 * DAY] } : {}) }));
  for (let i = 0; i < 5; i++) facts.push(fact(`s${i}`, { campaign: 'tiny', reg: NOW - 20 * DAY }));
  const q = sourceQuality({ facts, now: NOW, days: 30, predictedValue: (p) => (p.startsWith('g') ? 100_000 : 30_000), abuseFlag: (p) => p.startsWith('b') && Number(p.slice(1)) < 10, rgCase: () => false,
    spend: (c) => (c === 'good' ? 2_000_000 : c === 'bad' ? 2_000_000 : 0), name: (c) => ({ name: c, channel: 'affiliate' }) });
  const by = Object.fromEntries(q.sources.map((s) => [s.campaign_id, s]));
  assert.equal(by.good.verdict, 'buena');
  assert.equal(by.bad.verdict, 'mala');
  assert.ok(by.bad.reasons.some((r) => /primer depósito/.test(r)) && by.bad.reasons.some((r) => /abuso/.test(r)) && by.bad.reasons.some((r) => /peso invertido/.test(r)));
  assert.equal(by.tiny.verdict, 'sin_datos');
  assert.equal(q.sources[0].campaign_id, 'bad', 'las malas primero');
});

test('H6: CSV seguro (comillas, BOM, sin inyección de fórmulas) y exportación desde la API', async () => {
  const csv = toCsv(['a', 'b', 'c'], [['=HYPERLINK("x")', 'hola, "mundo"', -12.5], ['-0.500', '@cmd', null]]);
  assert.ok(csv.startsWith('﻿a,b,c\r\n'));
  assert.match(csv, /\r\n"'=HYPERLINK\(""x""\)","hola, ""mundo""",-12\.5\r\n/, 'fórmula neutralizada y comillas escapadas');
  assert.match(csv, /\r\n-0\.500,'@cmd,\r\n$/, 'números negativos intactos; @ neutralizado');
  const { app } = setup();
  const r = await route(app, { method: 'GET', path: '/analytics/journey-impact', query: new URLSearchParams('format=csv'), headers: { 'x-tenant-id': T, 'x-roles': 'crm_analyst', 'x-actor': 'a' }, body: {} });
  assert.equal(r.status, 200); assert.match(r.contentType!, /^text\/csv/); assert.equal(r.filename, 'impacto-recorridos.csv');
  assert.match(String(r.body), /^﻿recorrido,nombre,ventana_dias/);
  assert.equal((await route(app, { method: 'GET', path: '/analytics/sources', query: new URLSearchParams('format=csv'), headers: { 'x-tenant-id': T, 'x-roles': 'support', 'x-actor': 's' }, body: {} })).status, 403);
});

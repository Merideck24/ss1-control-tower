import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, onboard, ev, T } from './helpers.ts';
import { route } from '../src/api/router.ts';
import { parseCsv, csvToEvents } from '../src/ingestion/csvImport.ts';

const call = (app: ReturnType<typeof setup>['app'], method: string, path: string, roles: string, body: Record<string, unknown> = {}, q = '') =>
  route(app, { method, path, query: new URLSearchParams(q), headers: { 'x-tenant-id': T, 'x-roles': roles, 'x-actor': `${roles}@ss1` }, body });

test('B2: CSV con comillas, punto y coma y BOM; montos a unidades mínimas; errores por línea', () => {
  assert.deepEqual(parseCsv('﻿a;b\n"x;1";"di ""hola"""\r\n\n'), [['a', 'b'], ['x;1', 'di "hola"']]);
  const csv = 'player_id,occurred_at,deposit_id,amount,currency\np1,2026-11-20T10:00:00Z,d1,12500.50,COP\np2,ayer,d2,10,COP\np3,2026-11-20T10:00:00Z,d3,-5,COP\np4,2026-11-20T10:00:00Z,d4,10,pesos\n';
  const out = csvToEvents('deposit.settled', csv, { tenant_id: T, brand_id: 'rumbawin', source: 'csv.test' });
  assert.equal(out.rows, 4);
  assert.equal((out.events[0].payload as { amount_minor: number }).amount_minor, 1_250_050);
  assert.deepEqual(out.errors.map((e) => e.line), [3, 4, 5]);
  assert.match(csvToEvents('deposit.settled', 'player_id,amount\n', { tenant_id: T, brand_id: 'b', source: 's' }).errors[0].message, /Faltan columnas: occurred_at, deposit_id, currency/);
  assert.match(csvToEvents('player.registered', 'player_id,occurred_at,country,email_masked\np,2026-11-01T00:00:00Z,CO,ana@mail.com\n', { tenant_id: T, brand_id: 'b', source: 's' }).errors[0].message, /enmascarado/, 'no se aceptan emails en claro');
  assert.match(csvToEvents('consent.changed' as never, 'x\n', { tenant_id: T, brand_id: 'b', source: 's' }).errors[0].message, /no admitido/);
});

test('B2: validación sin cambios, carga todo-o-nada, histórico sin mensajes e idempotencia al resubir', async () => {
  const { app, clock } = setup();
  onboard(app, clock, 'p1');
  const csv = `player_id,occurred_at,deposit_id,amount,currency\np1,${clock.now().toISOString()},csv-d1,50000,COP\np1,${clock.now().toISOString()},csv-d2,25000.5,COP\n`;
  assert.equal((await call(app, 'POST', '/ingest/csv', 'crm_analyst', { event_type: 'deposit.settled', csv })).status, 403);
  const dry = (await call(app, 'POST', '/ingest/csv', 'tenant_admin', { event_type: 'deposit.settled', csv })).body as { valid: number; dry_run: boolean };
  assert.deepEqual([dry.valid, dry.dry_run], [2, true]);
  assert.equal(app.ingestor.get(T, 'p1')!.stats.deposit_count, 0, 'validar no cambia nada');
  const bad = (await call(app, 'POST', '/ingest/csv', 'tenant_admin', { event_type: 'deposit.settled', csv: csv + 'p1,mal,d3,1,COP\n', dry_run: false })).body as { error_count: number; applied?: number };
  assert.equal(bad.error_count, 1); assert.equal(bad.applied, 0, 'con errores no se carga nada');
  assert.equal(app.ingestor.get(T, 'p1')!.stats.deposit_count, 0);
  const sent = app.channels.receipts(T).length;
  const up = (await call(app, 'POST', '/ingest/csv', 'tenant_admin', { event_type: 'deposit.settled', csv, dry_run: false })).body as { applied: number; mode: string };
  assert.deepEqual([up.applied, up.mode], [2, 'historico']);
  assert.equal(app.ingestor.get(T, 'p1')!.stats.deposits_minor, 7_500_050);
  assert.equal(app.channels.receipts(T).length, sent, 'histórico: sin recorridos ni mensajes');
  const again = (await call(app, 'POST', '/ingest/csv', 'tenant_admin', { event_type: 'deposit.settled', csv, dry_run: false })).body as { applied: number; duplicate: number };
  assert.deepEqual([again.applied, again.duplicate], [0, 2], 'resubir no duplica');
  assert.equal(app.audit.list(T, { action: 'ingest.csv' }).length, 2);
});

test('B3: filtro por marca en jugadores, recorridos, rendimiento y Control Tower', async () => {
  const { app, clock } = setup();
  onboard(app, clock, 'a1');
  app.ingestor.ingest(ev(T, 'b1', 'player.registered', { email_masked: 'b***@m.co', country: 'CO', locale: 'es', timezone: 'America/Bogota', acquisition: { campaign_id: 'cb' } }, clock.now().toISOString(), { brand_id: 'otra' }));
  app.ingestor.ingest(ev(T, '', 'marketing.spend_reported', { campaign_id: 'cb', campaign_name: 'CB', channel: 'meta', date: clock.now().toISOString().slice(0, 10), impressions: 10, clicks: 1, spend: { amount_minor: 100_00, currency: 'COP' } }, clock.now().toISOString(), { brand_id: 'otra', source: 'ads.meta' }));
  const players = (await call(app, 'GET', '/players', 'support', {}, 'brand=otra')).body as { player_id: string }[];
  assert.deepEqual(players.map((p) => p.player_id), ['b1']);
  const brands = (await call(app, 'GET', '/brands', 'support')).body as { brand_id: string }[];
  assert.deepEqual(brands.map((b) => b.brand_id).sort(), ['otra', 'rumbawin']);
  assert.equal(((await call(app, 'GET', '/journeys', 'crm_analyst', {}, 'brand=otra')).body as unknown[]).length, 0, 'los recorridos son por marca');
  const perf = (await call(app, 'GET', '/performance', 'crm_analyst', {}, 'brand=otra')).body as { campaigns: { campaign_id: string; spend_minor: number }[] };
  assert.deepEqual(perf.campaigns.map((c) => c.campaign_id), ['cb']);
  const ct = (await call(app, 'GET', '/control-tower', 'crm_analyst', {}, 'brand=otra')).body as { brand: string; journeys: unknown[] };
  assert.equal(ct.brand, 'otra'); assert.equal(ct.journeys.length, 0);
});

test('B4: latencia evento→decisión medida con percentiles y objetivo, sin contar el reprocesamiento', async () => {
  const { app, clock } = setup();
  for (let i = 0; i < 30; i++) onboard(app, clock, `l${i}`);
  app.ingestor.ingest(ev(T, 'l0', 'deposit.settled', { deposit_id: 'rp', amount_minor: 1, currency: 'COP' }, clock.now().toISOString()), { replay: true });
  const lat = app.ingestor.latency(T);
  assert.ok(lat.n >= 150, `n=${lat.n}`);
  assert.ok(lat.p50_ms! <= lat.p95_ms! && lat.p95_ms! <= lat.p99_ms! && lat.p99_ms! <= lat.max_ms!);
  assert.ok(lat.by_type['player.verified'].n === 30);
  assert.equal(lat.by_type['deposit.settled'], undefined, 'el reprocesamiento histórico no cuenta');
  const ct = (await call(app, 'GET', '/control-tower', 'crm_analyst')).body as { latency: { slo_p95_ms: number; within_slo: boolean } };
  assert.equal(ct.latency.slo_p95_ms, 250); assert.equal(typeof ct.latency.within_slo, 'boolean');
});

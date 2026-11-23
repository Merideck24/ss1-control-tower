import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ev, T } from './helpers.ts';
import { computeRfm, distribution, lifecycleOf, rfmSegment } from '../src/analytics/rfm.ts';
import { runSegment } from '../src/segments/segmentEngine.ts';
import { DAY } from '../src/shared/util.ts';

function world() {
  const { app, clock } = setup('2026-11-15T15:00:00Z');
  const at = (d: number) => new Date(clock.now().getTime() - d * DAY).toISOString();
  const reg = (p: string, d: number) => app.ingestor.ingest(ev(T, p, 'player.registered', { email_masked: 'x', country: 'CO', locale: 'es', timezone: 'America/Bogota' }, at(d)), { replay: true });
  const dep = (p: string, d: number, amt: number) => app.ingestor.ingest(ev(T, p, 'deposit.settled', { deposit_id: `${p}-${d}-${amt}`, amount_minor: amt, currency: 'COP' }, at(d)), { replay: true });
  const bet = (p: string, d: number) => app.ingestor.ingest(ev(T, p, 'bet.settled', { bet_id: `${p}-b${d}`, stake: { amount_minor: 1000, currency: 'COP' }, product: 'casino' }, at(d)), { replay: true });
  reg('none', 40);
  reg('new', 10); dep('new', 10, 50_000);
  reg('active', 90); dep('active', 90, 50_000); for (const d of [80, 60, 40, 25, 10, 3]) bet('active', d);
  reg('risk', 90); dep('risk', 90, 50_000); bet('risk', 20);
  reg('gone', 120); dep('gone', 120, 50_000); bet('gone', 60);
  reg('back', 120); dep('back', 120, 50_000); bet('back', 80); bet('back', 2);
  // RFM: campeón (reciente, muchos depósitos, alto valor) vs. hibernando
  reg('champ', 200); for (const d of [1, 5, 9, 13, 17, 21]) dep('champ', d, 900_000);
  return { app, clock };
}

test('C3: etapas del ciclo de vida', () => {
  const { app, clock } = world();
  const life = (p: string) => lifecycleOf(app.ingestor.get(T, p)!, clock.now());
  assert.deepEqual(['none', 'new', 'active', 'risk', 'gone', 'back', 'champ'].map(life), ['sin_deposito', 'nuevo', 'activo', 'en_riesgo', 'inactivo', 'reactivado', 'activo']);
});

test('C2: reglas de segmentos RFM y quintiles con empates', () => {
  assert.equal(rfmSegment(5, 5, 5), 'campeones');
  assert.equal(rfmSegment(1, 5, 5), 'no_podemos_perderlos');
  assert.equal(rfmSegment(2, 3, 1), 'en_riesgo');
  assert.equal(rfmSegment(5, 1, 1), 'nuevos');
  assert.equal(rfmSegment(4, 2, 3), 'potenciales_leales');
  assert.equal(rfmSegment(3, 2, 2), 'necesitan_atencion');
  assert.equal(rfmSegment(1, 1, 1), 'hibernando');
  const { app, clock } = world();
  const rfm = computeRfm(app.ingestor.all(T), clock.now());
  assert.equal(rfm.has('none'), false, 'sin depósito no tiene RFM');
  assert.equal(rfm.get('champ')!.segment, 'campeones');
  assert.ok(rfm.get('gone')!.r < rfm.get('active')!.r);
  // empates: todos con 1 depósito excepto champ ⇒ mismo F
  const fs = ['new', 'active', 'risk', 'gone'].map((p) => rfm.get(p)!.f);
  assert.equal(new Set(fs).size, 1);
});

test('C2/C3: segmentos por rfm.segment y lifecycle; distribución', () => {
  const { app, clock } = world();
  const r = runSegment({ id: 's', tenant_id: T, name: 's', version: 1, rules: { or: [{ field: 'rfm.segment', op: 'eq', value: 'campeones' }, { field: 'lifecycle', op: 'in', value: ['en_riesgo', 'inactivo'] }] } }, app.ingestor.all(T), clock.now());
  assert.deepEqual(r.members, ['champ', 'gone', 'risk']);
  const d = distribution(app.ingestor.all(T), clock.now());
  assert.equal(d.total, 7); assert.equal(d.depositors, 6);
  assert.equal(d.lifecycle.find((x) => x.key === 'sin_deposito')!.players, 1);
  assert.equal(d.rfm.reduce((s, x) => s + x.players, 0), 6);
});

test('C2: API y copiloto usan los nuevos campos', async () => {
  const { app } = world();
  const prev = app.copilot.call({ tenant_id: T, operator_id: 'a', roles: ['crm_analyst'] }, 'preview_segment', { rules: { field: 'lifecycle', op: 'eq', value: 'activo' } });
  assert.ok(prev.ok);
  const { route } = await import('../src/api/router.ts');
  const res = await route(app, { method: 'GET', path: '/players/champ', query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': 'support' }, body: {} });
  const seg = (res.body as { segmentation: { lifecycle: { key: string }; rfm: { segment: string; label: string } } }).segmentation;
  assert.deepEqual([seg.lifecycle.key, seg.rfm.segment, seg.rfm.label], ['activo', 'campeones', 'Campeones']);
  assert.equal((await route(app, { method: 'GET', path: '/segments/rfm', query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': 'support' }, body: {} })).status, 403);
});

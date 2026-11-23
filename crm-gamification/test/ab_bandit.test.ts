import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ev, T } from './helpers.ts';
import { route } from '../src/api/router.ts';
import { probabilityBest, wilson, SplitTracker, type SplitNode } from '../src/experiments/bandit.ts';
import { reviewJourney } from '../src/journeys/builder.ts';
import { HOUR } from '../src/shared/util.ts';

const author = { id: 'ana@ss1', tenant_id: T, roles: ['crm_analyst' as const] };
const approver = { id: 'apr@ss1', tenant_id: T, roles: ['approver' as const] };

function splitJourney(mode: 'fixed' | 'bandit', weights = [1, 1, 1]): { split: SplitNode; def: Record<string, unknown> } {
  const split: SplitNode = { id: 'ab', type: 'split', mode, metric: { event: 'deposit.settled', window_hours: 48 }, warmup_per_variant: 40, min_explore_pct: 10,
    variants: [{ id: 'a', label: 'Email', weight: weights[0], next: 'e' }, { id: 'b', label: 'In-app', weight: weights[1], next: 'e' }, { id: 'c', label: 'Push', weight: weights[2], next: 'e' }] };
  return { split, def: { id: 'j_ab', brand_id: 'rumbawin', name: 'A/B/n de bienvenida', purpose: 'marketing', trigger: { event_type: 'player.registered' }, entry: 'ab', nodes: [split, { id: 'e', type: 'exit' }] } };
}
function run(mode: 'fixed' | 'bandit', players: number, rates: Record<string, number>, weights?: number[]) {
  const { app, clock } = setup('2026-09-01T15:00:00Z');
  const { split, def } = splitJourney(mode, weights);
  app.registry.saveDraft(author, def as never); app.registry.submit(author, 'j_ab'); app.registry.approve(approver, 'j_ab'); app.registry.publish(author, 'j_ab');
  let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const served: Record<string, number> = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < players; i++) {
    const p = `pl${i}`;
    app.ingestor.ingest(ev(T, p, 'player.registered', { email_masked: 'x***@m.co', country: 'CO', locale: 'es', timezone: 'America/Bogota' }, clock.now().toISOString()));
    const v = app.runtime.instances(T, { player_id: p, journey_id: 'j_ab' })[0].trace.find((s) => s.type === 'split')!.outcome.split(':')[1];
    served[v]++;
    if (rnd() < rates[v]) { clock.advance(HOUR); app.ingestor.ingest(ev(T, p, 'deposit.settled', { deposit_id: `${p}d`, amount_minor: 100_00, currency: 'COP' }, clock.now().toISOString())); }
    else clock.advance(HOUR);
  }
  clock.advance(49 * HOUR);
  return { app, clock, split, served, key: SplitTracker.key(T, 'j_ab', 'ab') };
}

test('D5: Beta-Binomial reproducible e intervalo de Wilson', () => {
  const s = [{ id: 'a', decided: 200, conversions: 20 }, { id: 'b', decided: 200, conversions: 40 }];
  const p1 = probabilityBest(s, 'seed'); const p2 = probabilityBest(s, 'seed');
  assert.deepEqual(p1, p2, 'misma semilla, mismo resultado');
  assert.ok(p1.b > 0.99 && Math.abs(p1.a + p1.b - 1) < 1e-9);
  const [lo, hi] = wilson(20, 200)!; assert.ok(lo < 0.1 && hi > 0.1 && lo > 0.06 && hi < 0.15);
  assert.equal(wilson(0, 0), null);
});

test('D5: el optimizador desplaza tráfico hacia la mejor variante sin dejar de explorar', () => {
  const { app, clock, split, served, key } = run('bandit', 1500, { a: 0.08, b: 0.22, c: 0.1 });
  const st = app.splits.stats(key, split, clock.now().getTime());
  const by = Object.fromEntries(st.map((x) => [x.id, x]));
  assert.ok(served.b > served.a && served.b > served.c, `la mejor recibe más tráfico: ${JSON.stringify(served)}`);
  assert.ok(served.b / 1500 > 0.5, 'más de la mitad del tráfico total');
  assert.ok(by.b.p_best! > 0.95, `alta probabilidad de ser la mejor: ${by.b.p_best}`);
  assert.ok(st.every((x) => x.allocation >= 0.1 - 1e-9), 'piso de exploración del 10 % por variante');
  assert.ok(st.every((x) => x.decided >= 40), 'todas pasaron el calentamiento');
  assert.ok(Math.abs(st.reduce((s, x) => s + x.allocation, 0) - 1) < 1e-9);
  // cada asignación guarda el reparto vigente (auditable)
  assert.ok(app.splits.assignments(key).every((a) => Math.abs(Object.values(a.allocation).reduce((s, x) => s + x, 0) - 1) < 1e-9));
});

test('D5: modo fijo respeta pesos, la asignación es estable por jugador y el informe da la decisión', async () => {
  const { app, served, key, split, clock } = run('fixed', 900, { a: 0.1, b: 0.1, c: 0.1 }, [2, 1, 0]);
  assert.equal(served.c, 0, 'peso 0 ⇒ sin tráfico');
  assert.ok(Math.abs(served.a / 900 - 2 / 3) < 0.05, `≈ 2/3 para peso 2: ${served.a}`);
  const again = app.splits.assign(T, 'j_ab', split, 'pl7', clock.now().getTime());
  assert.equal(again.variant, app.splits.assignments(key).find((a) => a.player_id === 'pl7')!.variant, 'misma variante siempre');
  const r = await route(app, { method: 'GET', path: '/experiments/splits', query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': 'crm_analyst', 'x-actor': 'a' }, body: {} });
  const sp = (r.body as { splits: { phase: string; variants: { id: string; decided: number }[]; decision: string }[] }).splits[0];
  assert.equal(sp.phase, 'fixed');
  assert.match(sp.decision, /Calentamiento|ganadora/);
  assert.equal((await route(app, { method: 'GET', path: '/experiments/splits', query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': 'support', 'x-actor': 's' }, body: {} })).status, 403);
});

test('D5: validación del nodo A/B/n con mensajes claros', () => {
  const ctx = { template: () => ({ purpose: 'marketing' as const }), reward: () => ({ approved: true }) };
  const base = { name: 'x', purpose: 'marketing' as const, control_group_pct: 10, trigger: { event_type: 'deposit.settled' as const }, entry: 'ab' };
  const one = reviewJourney({ ...base, nodes: [{ id: 'ab', type: 'split', mode: 'bandit', metric: { event: 'deposit.settled', window_hours: 0 }, min_explore_pct: 2, variants: [{ id: 'a', label: 'A', weight: 1, next: 'e' }] }, { id: 'e', type: 'exit' }] }, ctx);
  const codes = one.map((i) => i.code);
  assert.ok(codes.includes('split_variants') && codes.includes('split_metric') && codes.includes('low_exploration'));
  assert.ok(one.filter((i) => i.code.startsWith('split_')).every((i) => i.node === 'ab'));
  const zero = reviewJourney({ ...base, nodes: [{ id: 'ab', type: 'split', mode: 'fixed', metric: { event: 'deposit.settled', window_hours: 24 }, variants: [{ id: 'a', label: 'A', weight: 0, next: 'e' }, { id: 'b', label: 'B', weight: 0, next: 'e' }] }, { id: 'e', type: 'exit' }] }, ctx);
  assert.ok(zero.some((i) => i.code === 'split_weights'));
});

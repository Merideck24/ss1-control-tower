import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, T } from './helpers.ts';
import { route } from '../src/api/router.ts';
import { autoLayout, NODE_H, NODE_W } from '../src/journeys/builder.ts';
import type { JourneyNode } from '../src/journeys/model.ts';

const nodes: JourneyNode[] = [
  { id: 'w', type: 'wait', duration_ms: 3_600_000, next: 'c' },
  { id: 'c', type: 'condition', rule: { field: 'stats.deposit_count', op: 'gte', value: 3 }, on_true: 'r', on_false: 'e' },
  { id: 'r', type: 'grant_reward', reward_id: 'welcome_fs_10', next: 'e' },
  { id: 'e', type: 'exit' },
];

test('D2: el orden automático es determinista, por capas y sin solapes', () => {
  const a = autoLayout({ entry: 'w', nodes });
  assert.deepEqual(a, autoLayout({ entry: 'w', nodes: structuredClone(nodes) }), 'misma entrada, mismas posiciones');
  assert.ok(a.w.y < a.c.y && a.c.y < a.r.y && a.r.y < a.e.y, 'la salida queda debajo del camino más largo');
  const ps = Object.values(a);
  for (let i = 0; i < ps.length; i++) for (let k = i + 1; k < ps.length; k++) {
    const overlap = Math.abs(ps[i].x - ps[k].x) < NODE_W && Math.abs(ps[i].y - ps[k].y) < NODE_H;
    assert.ok(!overlap, 'sin nodos superpuestos');
  }
  const withOrphan = autoLayout({ entry: 'w', nodes: [...nodes, { id: 'o', type: 'exit' }] });
  assert.ok(withOrphan.o.y > withOrphan.e.y, 'pasos sueltos al final, visibles');
  assert.doesNotThrow(() => autoLayout({ entry: 'w', nodes: [{ id: 'w', type: 'wait', duration_ms: 1, next: 'w' }, { id: 'x', type: 'exit' }] }), 'ciclos no cuelgan el lienzo');
});

test('D2: la revisión en vivo explica errores en lenguaje claro y señala el paso', async () => {
  const { app } = setup();
  const call = (path: string, body: Record<string, unknown>, roles = 'crm_analyst') => route(app, { method: 'POST', path, query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': roles, 'x-actor': 'ana@ss1' }, body });
  const base = { id: 'j_canvas', brand_id: 'rumbawin', name: 'Lienzo', purpose: 'marketing', control_group_pct: 10, trigger: { event_type: 'deposit.settled' }, entry: 'w', nodes };
  const good = (await call('/journeys/review', base)).body as { valid: boolean; issues: unknown[]; layout: Record<string, unknown> };
  assert.equal(good.valid, true); assert.deepEqual(good.issues, []); assert.deepEqual(Object.keys(good.layout).sort(), ['c', 'e', 'r', 'w']);
  const broken = {
    ...base, purpose: 'service', control_group_pct: 0, nodes: [
      { id: 'w', type: 'wait', duration_ms: 0, next: 'm' },
      { id: 'm', type: 'message', channel: 'email', template: 'loyalty_halfway', next: 'c' },
      { id: 'c', type: 'condition', rule: { field: 'no.existe', op: 'eq', value: 1 }, on_true: '', on_false: 'e' },
      { id: 'r', type: 'grant_reward', reward_id: 'fantasma', next: 'e' },
      { id: 'e', type: 'exit' }],
  };
  const out = (await call('/journeys/review', broken)).body as { valid: boolean; issues: { node?: string; code: string; message: string }[] };
  assert.equal(out.valid, false);
  const by = (code: string) => out.issues.find((i) => i.code === code);
  assert.equal(by('invalid_wait')?.node, 'w');
  assert.equal(by('marketing_template_in_service')?.node, 'm');
  assert.match(by('invalid_rule')!.message, /«no\.existe», que no existe/);
  assert.equal(by('unconnected')?.node, 'c');
  assert.equal(by('unreachable')?.node, 'r');
  assert.equal(by('unknown_reward')?.node, 'r');
  assert.ok(by('service_journey_cannot_grant_incentives'));
  assert.ok(out.issues.every((i) => !/[a-z]+_[a-z]+:/.test(i.message)), 'sin códigos internos en los mensajes');
});

test('D2: lo dibujado en el lienzo se guarda con posiciones y pasa por el mismo flujo de aprobación', async () => {
  const { app } = setup();
  const call = (method: string, path: string, roles: string, body: Record<string, unknown> = {}) => route(app, { method, path, query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': roles, 'x-actor': `${roles}@ss1` }, body });
  const cat = (await call('GET', '/journeys/builder', 'crm_analyst')).body as { events: string[]; templates: { key: string }[]; rewards: { id: string; approved: boolean }[] };
  assert.ok(!cat.events.includes('marketing.spend_reported'), 'solo eventos de jugador como disparador');
  assert.ok(cat.templates.some((t) => t.key === 'reward_granted')); assert.ok(cat.rewards.some((r) => r.id === 'welcome_fs_10' && r.approved));
  const layout = { w: { x: 40, y: 20 }, c: { x: 40, y: 150 }, r: { x: 300, y: 280 }, e: { x: 40, y: 410 } };
  const def = { id: 'j_canvas', brand_id: 'rumbawin', name: 'Lienzo', purpose: 'marketing', control_group_pct: 10, trigger: { event_type: 'deposit.settled' }, entry: 'w', nodes, layout };
  assert.equal((await call('POST', '/journeys', 'crm_analyst', def)).status, 201);
  assert.equal((await call('POST', '/journeys/j_canvas/submit', 'crm_analyst')).status, 200);
  assert.equal((await call('POST', '/journeys/j_canvas/approve', 'crm_analyst')).status, 403, 'quien dibuja no aprueba');
  assert.equal((await call('POST', '/journeys/j_canvas/approve', 'approver')).status, 200);
  const saved = app.registry.list(T).find((j) => j.id === 'j_canvas')!;
  assert.deepEqual(saved.layout, layout);
  assert.equal(saved.status, 'approved');
});

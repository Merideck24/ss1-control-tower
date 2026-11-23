import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, onboard, ev, T } from './helpers.ts';
import { route } from '../src/api/router.ts';

const admin = { id: 'adm', tenant_id: T };
function world() {
  const s = setup('2026-11-15T15:00:00Z');
  const earn = (p: string, id: string, stakeCop: number) => s.app.ingestor.ingest(ev(T, p, 'bet.settled', { bet_id: id, stake: { amount_minor: stakeCop * 100, currency: 'COP' }, product: 'casino' }, s.clock.now().toISOString()));
  return { ...s, earn };
}

test('G6: monedas por apuesta e idempotentes; ajustes auditados con saldo no negativo', () => {
  const { app, clock, earn } = world();
  onboard(app, clock, 'p');
  earn('p', 'b1', 25_500); earn('p', 'b2', 999);
  assert.equal(app.store.balance(T, 'p'), 25, '1 moneda por COP 1.000; sin fracciones');
  assert.throws(() => app.store.adjust(admin, 'p', -100, 'corrección de prueba', 'r1'), /saldo insuficiente/);
  assert.throws(() => app.store.adjust(admin, 'p', 10, 'x', 'r2'), /motivo/);
  app.store.adjust(admin, 'p', 50, 'compensación por incidente', 'r3');
  app.store.adjust(admin, 'p', 50, 'compensación por incidente', 'r3');
  assert.equal(app.store.balance(T, 'p'), 75, 'ajuste idempotente por referencia');
  assert.equal(app.audit.list(T, { action: 'coins.adjusted' }).length, 2);
});

test('G6 (CRM-10): canjes simultáneos respetan stock y saldo', async () => {
  const { app, clock } = world();
  for (const p of ['a', 'b', 'c']) { onboard(app, clock, p); app.store.adjust(admin, p, 300, 'saldo de prueba', `seed-${p}`); }
  app.store.saveItem(admin, { id: 'last_one', name: 'Último', price_coins: 100, stock: 1, per_player_limit: 3, reward: { physical: 'x' }, active: true });
  const r1 = await Promise.allSettled([app.store.redeem(T, 'a', 'last_one', 'ra'), app.store.redeem(T, 'b', 'last_one', 'rb'), app.store.redeem(T, 'c', 'last_one', 'rc')]);
  assert.equal(r1.filter((r) => r.status === 'fulfilled').length, 1, 'solo un canje obtiene la última unidad');
  assert.ok(r1.filter((r) => r.status === 'rejected').every((r) => /sin stock/.test(String((r as PromiseRejectedResult).reason))));
  assert.equal(app.store.items(T)[0].stock, 0);
  assert.equal(['a', 'b', 'c'].map((p) => app.store.balance(T, p)).reduce((s, x) => s + x, 0), 800, 'solo se cobró un canje');
  app.store.saveItem(admin, { id: 'pricey', name: 'Caro', price_coins: 200, stock: 10, per_player_limit: 5, reward: { physical: 'y' }, active: true });
  const r2 = await Promise.allSettled([app.store.redeem(T, 'b', 'pricey', 'b1'), app.store.redeem(T, 'b', 'pricey', 'b2')]);
  assert.equal(r2.filter((r) => r.status === 'fulfilled').length, 1, 'saldo para uno solo');
  assert.equal(app.store.balance(T, 'b'), 100);
  const again = await app.store.redeem(T, 'b', 'pricey', 'b1');
  assert.equal(again.status, 'fulfilled'); assert.equal(app.store.balance(T, 'b'), 100, 'misma solicitud no cobra dos veces');
});

test('G6: reembolso compensatorio si la política bloquea el bono; límites y exclusiones', async () => {
  const { app, clock } = world();
  onboard(app, clock, 'nokyc', T, { verify: false }); onboard(app, clock, 'ok'); onboard(app, clock, 'out');
  for (const p of ['nokyc', 'ok', 'out']) app.store.adjust(admin, p, 1000, 'saldo de prueba', `s-${p}`);
  app.store.saveItem(admin, { id: 'fs_item', name: 'FS', price_coins: 300, stock: 5, per_player_limit: 1, reward: { reward_id: 'welcome_fs_10' }, active: true });
  const r = await app.store.redeem(T, 'nokyc', 'fs_item', 'x1');
  assert.equal(r.status, 'refunded'); assert.match(r.reason!, /kyc_not_verified/);
  assert.equal(app.store.balance(T, 'nokyc'), 1000); assert.equal(app.store.items(T)[0].stock, 5);
  assert.equal((await app.store.redeem(T, 'ok', 'fs_item', 'x2')).status, 'fulfilled');
  await assert.rejects(app.store.redeem(T, 'ok', 'fs_item', 'x3'), /límite/);
  app.loyalty.setOptOut(T, 'out', true);
  await assert.rejects(app.store.redeem(T, 'out', 'fs_item', 'x4'), /no elegible|desactivada/);
});

test('G7: predicciones con elección única, cierre, resolución idempotente y pago a quien acierta', async () => {
  const { app, clock } = world();
  for (const p of ['a', 'b', 'c']) onboard(app, clock, p);
  app.store.savePrediction(admin, { id: 'final', brand_id: 'rumbawin', name: 'F', question: '¿Quién gana?', options: ['L', 'E', 'V'], closes_at: '2026-11-16T00:00:00Z', reward: { coins: 100 } });
  app.store.pick(T, 'final', 'a', 'L'); app.store.pick(T, 'final', 'b', 'V'); app.store.pick(T, 'final', 'c', 'L');
  assert.throws(() => app.store.pick(T, 'final', 'a', 'V'), /no se puede cambiar/);
  assert.throws(() => app.store.resolve(admin, 'final', 'L'), /aún no cierra/);
  app.ingestor.ingest(ev(T, 'c', 'rg.status_changed', { status: 'self_excluded' }, clock.now().toISOString()));
  clock.set('2026-11-16T01:00:00Z');
  assert.throws(() => app.store.pick(T, 'final', 'b', 'L'), /ya cerró|cerrada/);
  const res = app.store.resolve(admin, 'final', 'L');
  assert.equal(res.payouts, 1, 'c acertó pero tiene restricción JR');
  app.store.resolve(admin, 'final', 'L');
  assert.deepEqual(['a', 'b', 'c'].map((p) => app.store.balance(T, p)), [100, 0, 0]);
  const call = (roles: string) => route(app, { method: 'POST', path: '/gamification/predictions/final/resolve', query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': roles }, body: { option: 'L' } });
  assert.equal((await call('crm_analyst')).status, 403);
  assert.equal((await call('approver')).status, 200);
});

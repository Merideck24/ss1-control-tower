import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, onboard, ev, T } from './helpers.ts';
import { route } from '../src/api/router.ts';
import { HOUR, DAY } from '../src/shared/util.ts';

const COP = (n: number) => ({ amount_minor: n * 100, currency: 'COP' });

function world() {
  const s = setup('2026-11-01T15:00:00Z');
  const at = () => s.clock.now().toISOString();
  const reg = (p: string, device?: string) => {
    s.app.ingestor.ingest(ev(T, p, 'player.registered', { email_masked: 'a***@m.co', country: 'CO', locale: 'es', timezone: 'America/Bogota', ...(device ? { device_hash: device } : {}) }, at()));
    onboard(s.app, s.clock, p);
  };
  const dep = (p: string, id: string, cop: number, instrument?: string) => s.app.ingestor.ingest(ev(T, p, 'deposit.settled', { deposit_id: id, ...COP(cop), ...(instrument ? { instrument_hash: instrument } : {}) }, at()));
  const bonus = (p: string, id: string, cop: number) => s.app.ingestor.ingest(ev(T, p, 'reward.granted', { grant_id: id, reward_type: 'bonus', value: COP(cop), expires_at: new Date(s.clock.now().getTime() + 7 * DAY).toISOString() }, at(), { source: 'ss1.bonus' }));
  const bet = (p: string, id: string, cop: number) => s.app.ingestor.ingest(ev(T, p, 'bet.settled', { bet_id: id, stake: COP(cop), product: 'casino' }, at()));
  const wd = (p: string, id: string, cop: number) => s.app.ingestor.ingest(ev(T, p, 'withdrawal.settled', { withdrawal_id: id, ...COP(cop) }, at()));
  return { ...s, reg, dep, bonus, bet, wd };
}

test('G9: jugador normal sin señales; bono → retiro rápido y cuentas vinculadas suben el riesgo con explicación', () => {
  const w = world();
  // jugador normal: deposita, recibe un bono y lo juega muchas veces
  w.reg('fair', 'dev-fair'); w.dep('fair', 'f1', 200_000, 'card-fair'); w.bonus('fair', 'fb1', 20_000);
  for (let i = 0; i < 12; i++) { w.bet('fair', `fbet${i}`, 30_000); w.clock.advance(HOUR); }
  // abusador: dos cuentas, mismo dispositivo; bono y retiro casi inmediato sin apostar
  for (const p of ['abuser1', 'abuser2']) {
    w.reg(p, 'dev-shared'); w.dep(p, `${p}-d1`, 20_000, `card-${p}`); w.bonus(p, `${p}-b1`, 20_000);
    w.bet(p, `${p}-bet`, 5_000); w.clock.advance(3 * HOUR); w.wd(p, `${p}-w1`, 35_000);
    w.clock.advance(DAY); w.bonus(p, `${p}-b2`, 20_000);
  }
  w.clock.advance(8 * DAY);
  const fair = w.app.abuse(T, 'fair')!;
  assert.equal(fair.tier, 'ok'); assert.deepEqual(fair.signals, []);
  assert.equal(fair.stats.bonus_turnover_x, 18);
  const a = w.app.abuse(T, 'abuser1')!;
  const codes = a.signals.map((s) => s.code).sort();
  assert.deepEqual(codes, ['bonus_heavy', 'bonus_withdraw_cycle', 'linked_accounts', 'low_turnover']);
  assert.equal(a.tier, 'high'); assert.equal(a.multiplier, 0);
  assert.deepEqual(a.stats.linked, [{ player_id: 'abuser2', via: 'device' }]);
  assert.ok(a.signals.every((s) => s.detail.length > 20), 'cada señal explica por qué');
});

test('G9: el bono se pausa para riesgo alto, se reduce para «vigilar» y se escala solo hasta el tope del artículo', () => {
  const w = world();
  w.app.rewards.addItem({ id: 'reload', tenant_id: T, brand_id: 'rumbawin', reward_type: 'bonus', value: COP(10_000), validity_days: 7, budget_minor: COP(1_000_000).amount_minor, approved_by: 'compliance@ss1', max_multiplier: 1.25 });
  const grant = (p: string, k: string) => w.app.rewards.grant({ tenant_id: T, player_id: p, reward_id: 'reload', idempotency_key: k, actor: 'test' });
  // riesgo alto: cuentas con mismo medio de pago + ciclo bono→retiro
  for (const p of ['x1', 'x2']) { w.reg(p); w.dep(p, `${p}d`, 10_000, 'card-same'); w.bonus(p, `${p}b`, 10_000); w.clock.advance(HOUR); w.wd(p, `${p}w`, 15_000); w.bonus(p, `${p}b2`, 10_000); }
  // vigilar: un solo ciclo bono → retiro
  w.reg('y'); w.dep('y', 'yd', 100_000); w.bonus('y', 'yb', 10_000); w.bet('y', 'ybet', 5_000); w.clock.advance(2 * HOUR); w.wd('y', 'yw', 50_000);
  // valioso: apuesta mucho más que lo recibido
  w.reg('v'); w.dep('v', 'vd', 500_000); w.bonus('v', 'vb', 10_000);
  for (let i = 0; i < 10; i++) w.bet('v', `vbet${i}`, 20_000);
  w.clock.advance(8 * DAY);
  assert.equal(w.app.abuse(T, 'x1')!.tier, 'high');
  const held = grant('x1', 'k-x1');
  assert.equal(held.status, 'failed'); assert.equal(held.reason, 'abuse_review');
  assert.equal(w.app.rewards.budget(T, 'reload')!.committed_minor, 0, 'no reserva presupuesto');
  assert.equal(w.app.audit.list(T, { action: 'reward.held_for_abuse_review' }).length, 1);
  assert.equal(w.app.abuse(T, 'y')!.tier, 'watch');
  const half = grant('y', 'k-y');
  assert.equal(half.status, 'confirmed'); assert.equal(half.value.amount_minor, COP(5_000).amount_minor); assert.equal(half.multiplier, 0.5);
  assert.ok(w.app.abuse(T, 'v')!.valuable);
  const up = grant('v', 'k-v');
  assert.equal(up.value.amount_minor, COP(12_500).amount_minor, 'escala +25 % por el tope del artículo');
  // sin tope en el artículo, nunca sube
  const welcome = w.app.rewards.grant({ tenant_id: T, player_id: 'v', reward_id: 'welcome_fs_10', idempotency_key: 'k-v2', actor: 'test' });
  assert.equal(welcome.value.amount_minor, w.app.rewards.item(T, 'welcome_fs_10')!.value.amount_minor);
  // jugador sin historial: sin cambios
  w.reg('new'); assert.equal(grant('new', 'k-new').value.amount_minor, COP(10_000).amount_minor);
});

test('G9: revisión humana auditada (descartar libera el bono), permisos y segmento abuse.tier', async () => {
  const w = world();
  for (const p of ['x1', 'x2']) { w.reg(p, 'dev-z'); w.dep(p, `${p}d`, 10_000); w.bonus(p, `${p}b`, 10_000); w.clock.advance(HOUR); w.wd(p, `${p}w`, 15_000); w.bonus(p, `${p}b2`, 10_000); }
  w.clock.advance(8 * DAY);
  const call = (method: string, path: string, roles: string[], body: Record<string, unknown> = {}) => route(w.app, { method, path, query: new URLSearchParams(), body, headers: {} }, { actor: { id: `${roles[0]}@ss1`, tenant_id: T, roles: roles as never } });
  const sum = await call('GET', '/risk/bonus-abuse', ['crm_analyst']);
  assert.equal(sum.status, 200);
  assert.equal((sum.body as { tiers: { high: number } }).tiers.high, 2);
  assert.equal((await call('GET', '/risk/bonus-abuse', ['support'])).status, 403);
  assert.equal((await call('POST', '/risk/bonus-abuse/x1/review', ['crm_analyst'], { status: 'cleared', note: 'hermanos, verificado' })).status, 403, 'quien analiza no decide');
  assert.equal((await call('POST', '/risk/bonus-abuse/x1/review', ['approver'], { status: 'cleared', note: '' })).status, 422);
  const ok = await call('POST', '/risk/bonus-abuse/x1/review', ['approver'], { status: 'cleared', note: 'hermanos en el mismo hogar, KYC verificado' });
  assert.equal(ok.status, 200);
  assert.equal(w.app.abuse(T, 'x1')!.multiplier, 1, 'descartado: bono normal');
  assert.equal(w.app.abuse(T, 'x1')!.tier, 'high', 'el puntaje no se borra; queda la revisión');
  assert.equal(w.app.rewards.grant({ tenant_id: T, player_id: 'x1', reward_id: 'welcome_fs_10', idempotency_key: 'r1', actor: 't' }).status, 'confirmed');
  assert.equal(w.app.audit.list(T, { action: 'abuse.review_cleared' }).length, 1);
  w.clock.advance(31 * DAY);
  assert.equal(w.app.abuse(T, 'x1')!.multiplier, 0, 'la revisión vence a los 30 días');
  const seg = await call('POST', '/segments/preview', ['crm_analyst'], { rules: { field: 'abuse.tier', op: 'eq', value: 'high' } });
  assert.deepEqual((seg.body as { sample: string[] }).sample.sort(), ['x1', 'x2']);
  const prof = await call('GET', '/players/x2', ['support']);
  assert.equal((prof.body as { bonus_abuse?: unknown }).bonus_abuse, undefined, 'soporte no ve el puntaje');
});

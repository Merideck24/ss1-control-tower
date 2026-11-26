/**
 * Recorrido completo de un jugador: registro → verificación → bono → depósitos y apuestas → puntos →
 * niveles (aviso del 50 % y subida) → retos (misiones, racha, torneo, ruleta, predicción, tienda) →
 * juego responsable. Comprueba que cada módulo entrega correctamente al siguiente y que las cifras
 * cuadran entre módulos (perfil, fidelidad, monedas, presupuestos, Control Tower, auditoría).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/api/router.ts';
import { seedDemoMissions } from '../src/demoAcquisition.ts';
import { assignArm } from '../src/experiments/experiments.ts';
import { setup, ev, T } from './helpers.ts';

const H = 3_600_000, D = 24 * H;
/** un jugador que cae en tratamiento (o en control) de todos los recorridos de marketing indicados */
const playerIn = (arm: 'treatment' | 'control', journeys: [string, number][]) => {
  for (let i = 0; i < 10_000; i++) { const id = `e2e_${arm}_${i}`; if (journeys.every(([j, pct]) => assignArm(T, j, id, pct) === arm)) return id; }
  throw new Error('sin candidato');
};

function world() {
  const { app, clock } = setup('2026-11-16T14:00:00Z'); // lunes 9:00 en Bogotá
  seedDemoMissions(app, T, clock.now().getTime());
  let n = 0;
  const send = (P: string, type: string, payload: unknown) => app.ingestor.ingest(ev(T, P, type as never, payload as never, clock.now().toISOString(), { event_id: `e2e-${P}-${++n}` } as never));
  const tick = (ms: number) => { const end = clock.now().getTime() + ms; while (clock.now().getTime() < end) { clock.advance(Math.min(H, end - clock.now().getTime())); app.policy.markRgFeedSynced(T); app.runtime.runDue(); } };
  const api = async (method: string, path: string, roles = 'tenant_admin', body: Record<string, unknown> = {}) => {
    const r = await route(app, { method, path, query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': roles, 'x-actor': `${roles}@ss1` }, body });
    return { status: r.status, body: r.body as any };
  };
  const onboard = (P: string) => {
    send(P, 'player.registered', { email_masked: 'j***@demo.test', country: 'CO', locale: 'es', timezone: 'America/Bogota' });
    send(P, 'rg.status_changed', { status: 'none' });
    for (const ch of ['inapp', 'email']) send(P, 'consent.changed', { purpose: 'marketing', channel: ch, granted: true });
    send(P, 'player.verified', { kyc_status: 'verified' });
  };
  const bet = (P: string, id: string, stake: number, product: 'casino' | 'sports' = 'casino', win = 0) => send(P, 'bet.settled', { bet_id: id, stake: { amount_minor: stake, currency: 'COP' }, win: { amount_minor: win, currency: 'COP' }, product });
  return { app, clock, send, tick, api, onboard, bet };
}

test('E2E: un jugador sube de nivel, completa los retos y cada módulo cuadra con los demás', async () => {
  const w = world();
  const P = playerIn('treatment', [['jx_welcome_bonus', 10], ['j3_reward_notice', 10], ['j5_level_up', 10]]);
  w.onboard(P); w.tick(2 * H);
  let d = (await w.api('GET', `/players/${P}`)).body;
  assert.deepEqual(d.grants.map((g: any) => [g.reward_id, g.status]), [['welcome_fs_10', 'confirmed']], 'bono de bienvenida al verificarse');
  assert.ok(w.app.adapters.inapp.list(T, P).items.some((m) => /Recibiste giros gratis por \$\s?1\.000/.test(m.body)), 'aviso de la recompensa en la bandeja');

  // 3 días: depósito + 8 rondas de casino + 2 apuestas deportivas
  for (let day = 0; day < 3; day++) {
    w.send(P, 'deposit.settled', { deposit_id: `dep${day}`, amount_minor: 200_000_00, currency: 'COP' });
    for (let i = 0; i < 8; i++) w.bet(P, `c${day}-${i}`, 50_000_00);
    for (let i = 0; i < 2; i++) w.bet(P, `s${day}-${i}`, 30_000_00, 'sports');
    w.tick(D);
  }
  d = (await w.api('GET', `/players/${P}`)).body;
  const ms = Object.fromEntries(d.gamification.missions.map((m: any) => [m.id, m]));
  assert.ok(ms.m_deposit_streak.completed_at && ms.m_casino_20.completed_at && ms.m_sports_5.completed_at, 'las tres misiones completas');
  assert.equal(d.grants.length, 2, 'la misión de casino entrega su recompensa');
  // 30 apuestas × 50k/30k = 1.380 pts por apuestas + 300 (racha) + 200 (deportes) = 1.880 → Plata
  assert.deepEqual([d.loyalty.level, d.loyalty.points], ['Plata', 1880]);
  const titles = () => w.app.adapters.inapp.list(T, P).items.map((m) => m.title);
  assert.ok(titles().includes('¡Vas a mitad de camino!'), 'aviso del 50 % hacia Plata');
  assert.ok(titles().includes('¡Subiste a Plata!'), 'felicitación al subir de nivel');
  assert.match(w.app.adapters.inapp.list(T, P).items.find((m) => m.title === '¡Subiste a Plata!')!.body, /Pasaste de Bronce a Plata\./);
  assert.ok(d.gamification.badges.some((b: any) => b.id === 'level_silver'));

  // tienda (150 monedas → 200 XP), ruleta (1 tirada al día), predicción
  const coins0 = d.gamification.coins;
  assert.equal((await w.api('POST', '/gamification/store/redeem', 'support', { player_id: P, item_id: 's_xp_boost', request_id: 'r1' })).body.status, 'fulfilled');
  assert.equal((await w.api('POST', '/gamification/minigames/g_daily_wheel/spin', 'support', { player_id: P, request_id: 'w1' })).status, 200);
  assert.equal((await w.api('POST', '/gamification/minigames/g_daily_wheel/spin', 'support', { player_id: P, request_id: 'w2' })).body.error, 'no_spins');
  assert.equal((await w.api('POST', '/gamification/predictions/p_final/pick', 'support', { player_id: P, option: 'Local' })).status, 200);
  d = (await w.api('GET', `/players/${P}`)).body;
  assert.equal(d.gamification.coins, coins0 - 150);

  // seguir apostando hasta Oro: aviso del 50 % hacia Oro y felicitación por Oro, una sola vez cada uno
  for (let i = 0; i < 40; i++) w.bet(P, `big${i}`, 100_000_00);
  w.tick(2 * H);
  d = (await w.api('GET', `/players/${P}`)).body;
  assert.equal(d.loyalty.level, 'Oro');
  // una decisión de felicitación por nivel; la de Oro respeta los topes de marketing del mercado
  // (a esta altura de la semana el jugador ya recibió 5 mensajes: queda suprimida y con su motivo)
  const ups = w.app.runtime.instances(T, { player_id: P, journey_id: 'j5_level_up' });
  assert.equal(ups.length, 2, 'Plata y Oro');
  const oro = w.app.channels.receipts(T, P).filter((r) => r.template === 'loyalty_level_up').at(-1)!;
  assert.ok(oro.status === 'accepted' || (oro.status === 'suppressed' && /frequency_cap/.test(oro.reason ?? '')), `${oro.status} ${oro.reason}`);
  assert.equal(titles().filter((t) => t === '¡Subiste a Oro!').length, oro.status === 'accepted' ? 1 : 0);
  assert.equal(titles().filter((t) => t === '¡Vas a mitad de camino!').length, 2, 'un aviso del 50 % por nivel');
  assert.ok(d.gamification.badges.some((b: any) => b.id === 'level_gold'));

  // cierre del torneo (1.er puesto: 1.000 XP) y de la predicción (+100 monedas)
  w.tick(6 * D);
  const before = d.loyalty.points, coinsBefore = d.gamification.coins;
  assert.equal((await w.api('POST', '/gamification/tournaments/t_sports_week/finalize', 'approver')).status, 200);
  assert.equal((await w.api('POST', '/gamification/predictions/p_final/resolve', 'approver', { option: 'Local' })).status, 200);
  d = (await w.api('GET', `/players/${P}`)).body;
  assert.equal(d.loyalty.points - before, 1000, 'premio del torneo');
  assert.equal(d.gamification.coins - coinsBefore, 100, 'premio de la predicción');

  // juego responsable: autoexclusión corta incentivos y marketing
  w.send(P, 'rg.status_changed', { status: 'self_excluded' });
  w.send(P, 'deposit.settled', { deposit_id: 'dep-x', amount_minor: 100_000_00, currency: 'COP' });
  w.tick(2 * H);
  const sent = w.app.channels.receipts(T, P).length;
  assert.equal((await w.api('POST', '/gamification/minigames/g_daily_wheel/spin', 'support', { player_id: P, request_id: 'wx' })).body.error, 'not_eligible');
  for (let i = 0; i < 25; i++) w.bet(P, `x${i}`, 100_000_00);
  w.tick(D);
  assert.equal(w.app.channels.receipts(T, P).filter((r) => r.status === 'accepted').length, w.app.channels.receipts(T, P).slice(0, sent).filter((r) => r.status === 'accepted').length, 'sin mensajes de marketing tras autoexcluirse');

  // cifras entre módulos
  const tower = (await w.api('GET', '/control-tower')).body;
  const accepted = w.app.channels.receipts(T).filter((r) => r.status === 'accepted').length;
  assert.equal(Object.entries(tower.deliveries as Record<string, number>).filter(([k]) => k.endsWith(':accepted')).reduce((s, [, v]) => s + v, 0), accepted, 'Control Tower = recibos');
  const committed = tower.budgets.find((b: any) => b.reward_id === 'welcome_fs_10').committed_minor;
  assert.equal(committed, w.app.rewards.grants(T).filter((g) => g.status !== 'failed').reduce((s, g) => s + g.value.amount_minor, 0), 'presupuesto = recompensas');
  assert.equal(w.app.ingestor.get(T, P)!.stats.deposits_minor, 700_000_00);
  assert.equal(w.app.audit.verifyChain(), true);
});

test('E2E: un jugador del grupo de control sube de nivel sin recibir la felicitación', async () => {
  const w = world();
  const P = playerIn('control', [['j5_level_up', 10]]);
  w.onboard(P); w.tick(H);
  for (let i = 0; i < 12; i++) w.bet(P, `b${i}`, 100_000_00);
  w.tick(H);
  assert.equal((await w.api('GET', `/players/${P}`)).body.loyalty.level, 'Plata');
  assert.equal(w.app.adapters.inapp.list(T, P).items.some((m) => m.title === '¡Subiste a Plata!'), false);
  assert.deepEqual(w.app.runtime.instances(T, { player_id: P, journey_id: 'j5_level_up' }).map((i) => i.status), ['held_out'], 'queda medido como control');
});

test('E2E: con datos del admin de SS1 (premios y reversiones sueltos) los retos no se inflan', async () => {
  const w = world();
  const P = playerIn('treatment', [['jx_welcome_bonus', 10]]);
  w.onboard(P); w.tick(H);
  // 10 apuestas de casino con su premio aparte (stake 0) y 2 reversiones: el admin las manda como movimientos sueltos
  for (let i = 0; i < 10; i++) { w.bet(P, `r${i}`, 50_000_00); w.bet(P, `r${i}`, 0, 'casino', 80_000_00); }
  const d0 = (await w.api('GET', `/players/${P}`)).body;
  w.bet(P, 'r0', -50_000_00); w.bet(P, 'r1', -50_000_00);
  w.tick(H);
  const d = (await w.api('GET', `/players/${P}`)).body;
  const casino = d.gamification.missions.find((m: any) => m.id === 'm_casino_20');
  assert.equal(casino.value, 10, 'los premios no cuentan como rondas (antes: 20/20 y misión completa)');
  assert.equal(casino.completed_at ?? null, null);
  assert.equal(d.loyalty.points, d0.loyalty.points - 100, 'cada reversión descuenta los 50 pts de su apuesta');
  assert.equal(d.gamification.coins, d0.gamification.coins - 2 * Math.floor(50_000_00 / (w.app.store as any).coinRateMinor), 'y sus monedas');
  assert.ok(w.app.ingestor.get(T, P)!.stats.bets_count === 10, 'el perfil cuenta 10 apuestas');
});

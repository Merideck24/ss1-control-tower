/**
 * Contrato real del admin de SS1. Las formas de estas filas salen del código del propio admin
 * (vistas Transacciones, Transacciones financieras, Jugadores y la sesión de login), documentado
 * en docs/SS1_DATA_CONTRACT.md. Los valores son ficticios.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ss1Client } from '../src/integration/ss1Client.ts';
import { connectorQuery, mapFinancial, mapGameTransaction, mapPlayer, runConnector, SS1_ENDPOINTS } from '../src/integration/ss1Connectors.ts';
import { extractProfile, Ss1IdentityProvider } from '../src/integration/ss1Identity.ts';
import { setup, T } from './helpers.ts';

const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();
const ctx = () => ({ tenant_id: T, brand_id: 'rumbawin', usernames: new Map<string, string>() });

test('Contrato SS1: jugador con country.value, kyc_status y responsible_gaming', () => {
  const c = ctx();
  const r = mapPlayer({ id: 501, username: 'jugador501', client: 3, country: { value: 'co', title: 'Colombia' }, currency_iso: 'COP', status: 1, kyc_status: 'approved', responsible_gaming: { self_excluded_until: FUTURE, has_deposit_limits: true }, created_at: '2026-10-01 08:00:00', updated_at: '2026-11-20 09:00:00' }, c);
  assert.deepEqual(r.events.map((e) => e.event_type), ['player.registered', 'player.verified', 'rg.status_changed']);
  assert.equal((r.events[0].payload as { country: string }).country, 'CO', 'country es un objeto { value } en el admin');
  assert.equal((r.events[2].payload as { status: string }).status, 'self_excluded', 'la autoexclusión vigente llega al CRM');
  assert.equal(c.usernames.get('jugador501'), '501', 'el username queda mapeado para los movimientos de juego');
  const limited = mapPlayer({ id: 502, created_at: '2026-10-01', kyc_status: 'pending', responsible_gaming: { self_excluded_until: '2020-01-01', has_deposit_limits: true } }, c);
  assert.deepEqual(limited.events.map((e) => [e.event_type, (e.payload as { status?: string }).status]), [['player.registered', undefined], ['rg.status_changed', 'limited']], 'autoexclusión vencida + límites → limited; KYC pendiente no verifica');
  assert.equal(mapPlayer({ id: 503, created_at: '2026-10-01', kyc_status: 'unverified' }, c).events.length, 1);
});

test('Contrato SS1: transacciones financieras con códigos numéricos (tipo 1–4, estado 0–2)', () => {
  const c = ctx();
  const row = (transaction_type: number, status: number) => ({ id: `F${transaction_type}${status}`, player_id: 501, currency: 'COP', transaction_type, status, amount: '50,000.00', created_at: '2026-11-03 12:00:00' });
  assert.deepEqual(mapFinancial(row(1, 2), c).events.map((e) => [e.event_type, (e.payload as { amount_minor: number }).amount_minor]), [['deposit.settled', 5_000_000]]);
  assert.equal(mapFinancial(row(2, 2), c).events[0].event_type, 'withdrawal.settled');
  assert.equal(mapFinancial(row(1, 1), c).skipped[0].reason, 'depósito en estado pending');
  assert.equal(mapFinancial(row(1, 0), c).skipped[0].reason, 'depósito en estado failed');
  assert.match(mapFinancial(row(3, 2), c).skipped[0].reason, /bonus/, 'bonos no son depósitos');
  assert.match(mapFinancial(row(4, 2), c).skipped[0].reason, /adjustment/);
  assert.equal(mapFinancial({ ...row(1, 2), currency: { iso: 'cop' } }, c).events.length, 1, 'moneda como objeto');
});

test('Contrato SS1: movimientos de juego → GGR = apostado − premios − reversiones (solo confirmados)', () => {
  const { app } = setup();
  const c = ctx();
  c.usernames.set('jugador501', '501');
  app.ingestor.ingest(mapPlayer({ id: 501, username: 'jugador501', created_at: '2026-10-01' }, c).events[0], { replay: true });
  const tx = (id: number, transaction_type: string, amount: string, extra: Record<string, unknown> = {}) => ({ id, transaction_type, amount, balance: '0', currency: 'COP', player: 'jugador501', provider_round: `R${Math.ceil(id / 2)}`, status: true, is_free_spin: false, created_at: `2026-11-10 10:00:0${id % 10}`, ...extra });
  const rows = [
    tx(1, 'DEBIT', '10,000.00'), tx(2, 'CREDIT', '25,000.00'),      // ronda ganada
    tx(3, 'DEBIT', '5,000.00'), tx(4, 'ROLLBACK', '5,000.00'),      // apuesta devuelta
    tx(5, 'DEBIT', '8,000.00'),                                      // ronda perdida
    tx(6, 'FREE_SPIN', '1,000.00', { is_free_spin: true }),          // giro gratis: no es apuesta
    tx(7, 'CREDIT', '3,000.00', { is_free_spin: true }),             // premio de giro gratis: sí es premio
    tx(8, 'DEBIT', '99,000.00', { status: false }),                  // rechazado por la wallet
  ];
  const skipped: string[] = [];
  for (const r of rows) {
    const out = mapGameTransaction(r, c);
    skipped.push(...out.skipped.map((s) => s.reason));
    for (const e of out.events) assert.equal(app.ingestor.ingest(e, { replay: true }).status, 'applied');
  }
  assert.deepEqual(skipped, ['giro gratis: la apuesta no se cobra', 'movimiento no confirmado por la wallet']);
  const s = app.ingestor.get(T, '501')!.stats;
  // apostado 10.000 + 5.000 + 8.000 − reversión 5.000 = 18.000; premios 25.000 + 3.000 = 28.000
  assert.deepEqual([s.stake_minor, s.win_minor, s.stake_minor - s.win_minor], [1_800_000, 2_800_000, -1_000_000]);
  assert.equal(s.bets_count, 3, 'solo las apuestas cobradas cuentan como apuestas');
  assert.equal(mapGameTransaction(tx(9, 'DEBIT', '1.00', { player: 'desconocido' }), c).skipped[0].reason.startsWith('jugador sin id'), true);
  assert.equal(mapGameTransaction(tx(1, 'DEBIT', '10,000.00'), c).events[0].event_id, 'ss1:gametx:1:bet.settled', 'id determinista: resincronizar no duplica');
});

test('Contrato SS1: sincronización con filter[...] y paginación { pagination.total_pages }', async () => {
  const { app } = setup();
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    const u = new URL(url);
    seen.push(u.pathname + u.search);
    const page = Number(u.searchParams.get('page'));
    if (u.pathname === SS1_ENDPOINTS.players) return Response.json({ data: [{ id: 501, username: 'jugador501', country: { value: 'CO' }, created_at: '2026-10-01 08:00:00' }], pagination: { current_page: 1, total_pages: 1, total: 1 } });
    if (u.pathname === SS1_ENDPOINTS.games) {
      const data = page === 1 ? [{ id: 1, transaction_type: 'DEBIT', amount: '100.00', currency: 'COP', player: 'jugador501', status: true, created_at: '2026-11-10 10:00:00' }] : [{ id: 2, transaction_type: 'CREDIT', amount: '40.00', currency: 'COP', player: 'jugador501', status: true, created_at: '2026-11-10 10:00:05' }];
      return Response.json({ data, pagination: { current_page: page, total_pages: 2, total: 2 }, totals: { profit: { raw: 60 } } });
    }
    return new Response('nf', { status: 404 });
  }) as unknown as typeof fetch;
  const client = new Ss1Client({ apiBase: 'https://api.test', token: 't'.repeat(20), fetchImpl, sleep: async () => {} });
  const c = ctx();
  const p = await runConnector('players', client, app.ingestor, c, connectorQuery('players'));
  const g = await runConnector('games', client, app.ingestor, c, connectorQuery('games', '2026-11-10T00:00:00Z'));
  assert.deepEqual([p.ingested, g.fetched, g.ingested, g.skipped], [1, 2, 2, 0], 'se leen las dos páginas (antes se cortaba en la primera)');
  const gq = new URLSearchParams(seen.find((s) => s.startsWith(SS1_ENDPOINTS.games))!.split('?')[1]);
  assert.deepEqual([gq.get('filter[settlement]'), gq.get('filter[fromDate]'), gq.get('filter[per_page]')], ['settled', '2026-11-10 00:00:00', '500']);
  const st = app.ingestor.get(T, '501')!.stats;
  assert.deepEqual([st.stake_minor, st.win_minor], [10_000, 4_000]);
});

test('Contrato SS1: sesión del admin { userData, userAbilities } y ruta de perfil por defecto', async () => {
  const login = { accessToken: 'x', userData: { id: 12, clientId: 3, clientParentId: null, role: 'operator_admin', timezone: 'America/Bogota', walletType: 'regular' }, userAbilities: [{ action: 'read', subject: 'crm' }, { action: 'manage', subject: 'crm_journeys' }] };
  assert.deepEqual(extractProfile(login), { userId: '12', name: undefined, client: '3', rules: login.userAbilities });
  const calls: string[] = [];
  const id = new Ss1IdentityProvider({ apiBase: 'https://api.test', profilePath: undefined, tenantMap: { 3: 'tenant-rumbawin' }, fetchImpl: (async (url: string) => { calls.push(url); return Response.json(login); }) as unknown as typeof fetch });
  const r = await id.resolve('Bearer ' + 'k'.repeat(30), undefined);
  assert.deepEqual(calls, ['https://api.test/admin/auth/me'], 'SS1_PROFILE_PATH sin definir no deja la ruta en "undefined"');
  assert.equal(r.ok && r.actor.tenant_id, 'tenant-rumbawin');
  // /admin/bootstrap trae catálogos, no un usuario: no debe confundirse con una sesión
  assert.equal(extractProfile({ countries: [], currencies: [], clients: [{ id: 3 }], roles: [] }), null);
});

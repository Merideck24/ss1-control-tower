import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ss1Client, toMinor } from '../src/integration/ss1Client.ts';
import { mapFinancial, mapPlayer, mapTriggerCatalog, runConnector } from '../src/integration/ss1Connectors.ts';
import { route } from '../src/api/router.ts';
import { setup, T } from './helpers.ts';

const ctx = { tenant_id: T, brand_id: 'rumbawin' };

test('A3: montos decimales → unidades mínimas sin coma flotante', () => {
  assert.equal(toMinor('100.50', 'COP'), 10050);
  assert.equal(toMinor('0.1', 'USD'), 10);
  assert.equal(toMinor(19.99, 'EUR'), 1999);
  assert.equal(toMinor('1,234.565', 'USD'), 123457);
  assert.equal(toMinor('5000', 'CLP'), 5000);
  assert.equal(toMinor('-20.00', 'COP'), -2000);
  assert.throws(() => toMinor('abc', 'COP'));
});

test('A3: mapeo de jugador y transacciones con campos tolerantes', () => {
  const p = mapPlayer({ id: 77, email: 'ana.perez@mail.com', created_at: '2026-11-01 10:00:00', country_code: 'CO', kyc: { status: 'approved', updated_at: '2026-11-02T00:00:00Z' }, affiliate: { id: 'aff-9' } }, ctx);
  assert.deepEqual(p.events.map((e) => e.event_type), ['player.registered', 'player.verified']);
  assert.equal((p.events[0].payload as { email_masked: string }).email_masked, 'a***@mail.com');
  assert.deepEqual((p.events[0].payload as { acquisition: unknown }).acquisition, { campaign_id: 'aff-9', channel: 'affiliate' });
  assert.equal(p.events[0].event_id, 'ss1:player:77:player.registered');
  const d = mapFinancial({ id: 'T1', player: { id: 77 }, currency: 'cop', type: 'DEPOSIT', status: 'approved', amount: '50000.00', updated_at: '2026-11-03T12:00:00Z' }, ctx);
  assert.deepEqual(d.events[0].payload, { deposit_id: 'T1', amount_minor: 5_000_000, currency: 'COP' });
  assert.equal(mapFinancial({ id: 'T2', player_id: 77, currency: 'COP', type: 'deposit', status: 'refunded', amount: 10, created_at: '2026-11-04' }, ctx).events[0].event_type, 'deposit.reversed');
  assert.equal(mapFinancial({ id: 'T3', player_id: 77, currency: 'COP', type: 'withdrawal', status: 'paid', amount: '20000', created_at: '2026-11-05' }, ctx).events[0].event_type, 'withdrawal.settled');
  assert.equal(mapFinancial({ id: 'T4', player_id: 77, currency: 'COP', type: 'deposit', status: 'pending', amount: 1, created_at: '2026-11-05' }, ctx).skipped[0].reason, 'depósito en estado pending');
  assert.equal(mapFinancial({ id: 'T5', currency: 'COP', type: 'deposit', status: 'approved', amount: 1 }, ctx).skipped.length, 1);
  assert.deepEqual(mapTriggerCatalog({ data: { first_deposit: 'Primer depósito', registration: { label: 'Registro' } } }), [{ key: 'first_deposit', label: 'Primer depósito' }, { key: 'registration', label: 'Registro' }]);
  assert.deepEqual(mapTriggerCatalog([{ value: 'login', name: 'Inicio de sesión' }]), [{ key: 'login', label: 'Inicio de sesión' }]);
});

function fakeAdmin() {
  let rate = 1;
  const fetchImpl = (async (url: string) => {
    const u = new URL(url);
    if (rate > 0 && u.pathname === '/admin/players') { rate--; return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }); }
    const page = Number(u.searchParams.get('page'));
    if (u.pathname === '/admin/players') return Response.json({ data: page === 1 ? [{ id: 1, email: 'a@x.co', created_at: '2026-11-01T00:00:00Z' }, { id: 2, created_at: '2026-11-02T00:00:00Z', kyc_status: 'approved' }] : [{ id: 3, created_at: '2026-11-03T00:00:00Z' }], current_page: page, last_page: 2 });
    if (u.pathname === '/admin/transactions/financial') return Response.json({ data: [{ id: 'd1', player_id: 1, type: 'deposit', status: 'completed', amount: '100000.00', currency: 'COP', created_at: '2026-11-02T00:00:00Z' }, { id: 'x', player_id: 1, type: 'bonus', status: 'completed', amount: '1', currency: 'COP', created_at: '2026-11-02T00:00:00Z' }], meta: { current_page: 1, last_page: 1 } });
    if (u.pathname === '/admin/withdrawal-requests') return new Response('{}', { status: 403 });
    if (u.pathname === '/admin/bonus-campaigns/trigger-catalog') return Response.json({ data: [{ key: 'first_deposit', label: 'Primer depósito' }] });
    return new Response('nf', { status: 404 });
  }) as unknown as typeof fetch;
  return fetchImpl;
}

test('A3: sincronización paginada, reintento ante 429, idempotente al repetir y sin abortar por un conector fallido', async () => {
  const { app } = setup();
  const client = new Ss1Client({ apiBase: 'https://api.test', token: 't'.repeat(20), fetchImpl: fakeAdmin(), sleep: async () => {} });
  const r1 = await runConnector('players', client, app.ingestor, ctx);
  assert.deepEqual([r1.fetched, r1.ingested, r1.error], [3, 4, undefined]);
  const r2 = await runConnector('players', client, app.ingestor, ctx);
  assert.deepEqual([r2.ingested, r2.duplicates], [0, 4]);
  const f = await runConnector('financial', client, app.ingestor, ctx);
  assert.deepEqual([f.ingested, f.skipped], [1, 1]);
  assert.equal(app.ingestor.get(T, '1')!.stats.deposits_minor, 10_000_000);
  // backfill: el jugador 2 verificado no dispara el recorrido de bono ni otros efectos
  assert.equal(app.runtime.instances(T, { player_id: '2' }).length, 0);
  assert.equal(app.rewards.grants(T).length, 0);
  assert.equal(app.channels.receipts(T).length, 0);
  const w = await runConnector('withdrawals', client, app.ingestor, ctx);
  assert.match(w.error!, /^403/);
});

test('A3: endpoints de integración: permisos, modo no integrado y auditoría', async () => {
  const { app } = setup();
  const call = (method: string, path: string, roles: string, ss1?: boolean, body: Record<string, unknown> = {}) => route(app, { method, path, query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': roles }, body }, ss1 ? { ss1: { apiBase: 'https://api.test', token: 't'.repeat(20), fetchImpl: fakeAdmin() } } : {});
  assert.equal((await call('POST', '/integration/ss1/sync', 'crm_analyst', true)).status, 403);
  assert.equal((await call('POST', '/integration/ss1/sync', 'tenant_admin')).status, 409);
  const cat = await call('GET', '/integration/ss1/trigger-catalog', 'crm_analyst', true);
  assert.deepEqual((cat.body as { triggers: unknown[] }).triggers, [{ key: 'first_deposit', label: 'Primer depósito' }]);
  const s = await call('POST', '/integration/ss1/sync', 'tenant_admin', true, { connectors: ['financial', 'evil'] });
  assert.deepEqual((s.body as { reports: { connector: string }[] }).reports.map((r) => r.connector), ['financial']);
  assert.equal(app.audit.list(T, { action: 'integration.ss1_sync' }).length, 1);
});

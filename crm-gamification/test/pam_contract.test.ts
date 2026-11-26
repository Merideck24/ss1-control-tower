/**
 * Primera prueba de contrato con el PAM de SS1.
 * La misma suite corre contra cada adaptador (`PamSource`): el sandbox en memoria y el cliente HTTP
 * real (`Ss1Client`) frente a un servidor simulado con la forma del admin. Un adaptador nuevo
 * se acepta solo si pasa esta suite. Filas con valores ficticios y la forma documentada en
 * docs/SS1_DATA_CONTRACT.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ss1Client } from '../src/integration/ss1Client.ts';
import { CONNECTORS, connectorQuery, runConnector, SS1_ENDPOINTS, type ConnectorName } from '../src/integration/ss1Connectors.ts';
import { inRollout, PAM_SCOPES, SandboxPam, type PamRow, type PamSource } from '../src/integration/pam.ts';
import { setup, T, T2 } from './helpers.ts';

const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();
const FIXTURE: Record<ConnectorName, PamRow[]> = {
  players: [
    { id: 701, username: 'ana701', client: 3, country: { value: 'co' }, currency_iso: 'COP', kyc_status: 'approved', created_at: '2026-10-01 08:00:00', updated_at: '2026-11-01 08:00:00' },
    { id: 702, username: 'beto702', client: 3, country: { value: 'co' }, kyc_status: 'pending', created_at: '2026-10-02 08:00:00' },
    { id: 703, username: 'caro703', client: 3, country: { value: 'co' }, kyc_status: 'approved', responsible_gaming: { self_excluded_until: FUTURE }, created_at: '2026-10-03 08:00:00', updated_at: '2026-11-02 08:00:00' },
  ],
  financial: [
    { id: 'F1', player_id: 701, currency: 'COP', transaction_type: 1, status: 2, amount: '50,000.00', created_at: '2026-11-03 12:00:00' },
    { id: 'F2', player_id: 701, currency: 'COP', transaction_type: 1, status: 1, amount: '20,000.00', created_at: '2026-11-04 12:00:00' }, // pendiente: no cuenta
    { id: 'F3', player_id: 703, currency: 'COP', transaction_type: 3, status: 2, amount: '10,000.00', created_at: '2026-11-04 12:00:00' },  // bono: no es depósito
  ],
  withdrawals: [],
  games: [
    { id: 11, transaction_type: 'DEBIT', amount: '10,000.00', currency: 'COP', player: 'ana701', status: true, created_at: '2026-11-05 10:00:00' },
    { id: 12, transaction_type: 'CREDIT', amount: '4,000.00', currency: 'COP', player: 'ana701', status: true, created_at: '2026-11-05 10:00:05' },
    { id: 13, transaction_type: 'DEBIT', amount: '1,000.00', currency: 'COP', player: 'nadie', status: true, created_at: '2026-11-05 10:00:06' }, // sin mapeo de id
  ],
};

/** Servidor simulado del admin: listas paginadas `{ data, pagination: { total_pages } }`, exige Bearer. */
function fakeAdmin(token: string, pageSize = 2) {
  const log: { method: string; path: string }[] = [];
  const byPath = new Map(Object.entries(FIXTURE).map(([k, v]) => [SS1_ENDPOINTS[k as ConnectorName], v]));
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    log.push({ method: init?.method ?? 'GET', path: u.pathname });
    if ((init?.headers as Record<string, string>)?.authorization !== `Bearer ${token}`) return new Response('{"message":"Unauthenticated."}', { status: 401 });
    const rows = byPath.get(u.pathname);
    if (!rows) return new Response('nf', { status: 404 });
    const page = Number(u.searchParams.get('page') ?? 1);
    const total_pages = Math.max(1, Math.ceil(rows.length / pageSize));
    return Response.json({ data: rows.slice((page - 1) * pageSize, page * pageSize), pagination: { current_page: page, total_pages, total: rows.length } });
  }) as unknown as typeof fetch;
  return { fetchImpl, log };
}

const TOKEN = 'svc-' + 'x'.repeat(28);
const ADAPTERS: [string, () => { source: PamSource; writes: () => number }][] = [
  ['SandboxPam', () => { const s = new SandboxPam(FIXTURE, { pageSize: 2 }); return { source: s, writes: () => 0 }; }],
  ['Ss1Client (HTTP)', () => { const f = fakeAdmin(TOKEN); return { source: new Ss1Client({ apiBase: 'https://admin.test', token: TOKEN, fetchImpl: f.fetchImpl, sleep: async () => {} }), writes: () => f.log.filter((l) => l.method !== 'GET').length }; }],
];

async function syncAll(source: PamSource, app: ReturnType<typeof setup>['app'], tenant = T) {
  const ctx = { tenant_id: tenant, brand_id: 'rumbawin', usernames: new Map<string, string>() };
  const out: Record<string, Awaited<ReturnType<typeof runConnector>>> = {};
  for (const c of CONNECTORS) out[c] = await runConnector(c, source, app.ingestor, ctx, connectorQuery(c));
  return out;
}

for (const [name, make] of ADAPTERS) {
  test(`Contrato PAM [${name}]: sincronización completa, mapeo de IDs y datos del PAM con procedencia`, async () => {
    const { app } = setup();
    const { source, writes } = make();
    const rep = await syncAll(source, app);
    assert.deepEqual(CONNECTORS.map((c) => rep[c].error), [undefined, undefined, undefined, undefined]);
    assert.deepEqual([rep.players.fetched, rep.financial.fetched, rep.games.fetched], [3, 3, 3], 'se leen todas las páginas');
    // ID del CRM = id del PAM como texto; el username del movimiento de juego se resuelve al id
    const ana = app.ingestor.get(T, '701')!;
    assert.ok(ana && app.ingestor.get(T, '702') && app.ingestor.get(T, '703'));
    assert.deepEqual([ana.stats.deposits_minor, ana.stats.stake_minor, ana.stats.win_minor], [5_000_000, 1_000_000, 400_000]);
    assert.ok(rep.games.samples_skipped.some((s) => /jugador sin id/.test(s.reason)), 'movimiento sin mapeo: se omite con motivo');
    assert.ok(rep.financial.samples_skipped.some((s) => /pending/.test(s.reason)) && rep.financial.samples_skipped.some((s) => /bonus/.test(s.reason)));
    // datos que son del PAM llegan con su procedencia y versión
    assert.deepEqual([ana.kyc?.value, ana.kyc?.source], ['verified', 'ss1.admin']);
    assert.equal(app.ingestor.get(T, '702')!.kyc?.value, 'pending');
    assert.deepEqual([app.ingestor.get(T, '703')!.rg?.value, app.ingestor.get(T, '703')!.rg?.source], ['self_excluded', 'ss1.admin']);
    // la autoexclusión que viene del PAM bloquea el marketing (fail-closed también sin consentimientos)
    assert.equal(app.policy.decide({ profile: app.ingestor.get(T, '703')!, purpose: 'marketing', channel: 'inapp' }).kind, 'suppress');
    assert.equal(writes(), 0, 'el CRM nunca escribe en el PAM');
  });

  test(`Contrato PAM [${name}]: resincronizar es idempotente y no cruza tenants`, async () => {
    const { app } = setup();
    await syncAll(make().source, app);
    const before = structuredClone(app.ingestor.get(T, '701')!.stats);
    const again = await syncAll(make().source, app);
    assert.deepEqual(CONNECTORS.map((c) => again[c].ingested), [0, 0, 0, 0], 'segunda pasada: nada nuevo');
    assert.ok(again.players.duplicates >= 3 && again.games.duplicates === 2);
    assert.deepEqual(app.ingestor.get(T, '701')!.stats, before, 'los totales no se duplican');
    assert.equal(app.ingestor.get(T2, '701'), undefined, 'otro tenant no ve los jugadores sincronizados');
  });
}

test('Contrato PAM [Ss1Client]: credencial inválida → error 401 explícito, sin filtrar el token y sin reintentos', async () => {
  const { app } = setup();
  const f = fakeAdmin(TOKEN);
  const client = new Ss1Client({ apiBase: 'https://admin.test', token: 'svc-' + 'y'.repeat(28), fetchImpl: f.fetchImpl, sleep: async () => {} });
  const rep = await runConnector('players', client, app.ingestor, { tenant_id: T, brand_id: 'rumbawin' }, connectorQuery('players'));
  assert.match(rep.error ?? '', /^401/);
  assert.ok(!JSON.stringify(rep).includes('yyyy'), 'el reporte no contiene la credencial');
  assert.equal(f.log.length, 1, '401 no se reintenta');
  assert.equal(rep.ingested, 0);
});

test('Contrato PAM: alcances de solo lectura por conector y activación gradual estable', () => {
  assert.deepEqual(Object.keys(PAM_SCOPES).sort(), [...CONNECTORS].sort());
  assert.ok(Object.values(PAM_SCOPES).every((s) => s.endsWith(':read')), 'solo alcances de lectura');
  const ids = Array.from({ length: 2000 }, (_, i) => `p${i}`);
  const ten = ids.filter((id) => inRollout(id, 10)).length;
  assert.ok(ten > 140 && ten < 260, `≈10 %: ${ten}`);
  assert.ok(ids.every((id) => !inRollout(id, 10) || inRollout(id, 50)), 'quien entró al 10 % sigue dentro al 50 %');
  assert.equal(ids.filter((id) => inRollout(id, 0)).length, 0);
  assert.equal(ids.filter((id) => inRollout(id, 100)).length, 2000);
});

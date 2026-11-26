/**
 * Contrato PAM, Fase 2: sonda de identidad (GET /admin/auth/me) antes de leer datos y validación
 * de filas contra los esquemas del CRM. Fixtures SINTÉTICOS en test/fixtures/pam.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeCredential, runPamContract, validateRows } from '../src/integration/pamContract.ts';
import { SandboxPam } from '../src/integration/pam.ts';
import { mapPlayer } from '../src/integration/ss1Connectors.ts';
import { setup, T, T2 } from './helpers.ts';

const FX = (n: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/pam', `${n}.json`), 'utf8'));
const TOKEN = 'ro-' + 'z'.repeat(30);
const answer = (status: number, body?: unknown) => (async () => (body === undefined ? new Response('{"message":"x"}', { status }) : Response.json(body, { status }))) as unknown as typeof fetch;
const probe = (fetchImpl: typeof fetch, expectTenant = T) => probeCredential({ apiBase: 'https://ss1.test', token: TOKEN, tenantMap: { '3': T }, expectTenant, fetchImpl });

test('Contrato PAM · sonda: credencial de solo lectura del tenant correcto → continúa, con identidad y permisos', async () => {
  const r = await probe(answer(200, FX('auth_me_ok')));
  assert.equal(r.ok, true);
  assert.deepEqual(r.identity, { user_id: 'svc-crm-ro', client: '3', tenant: T });
  assert.deepEqual(r.read_subjects, ['players', 'transactions', 'withdrawals']);
  assert.equal(r.write_rules, 0);
  assert.deepEqual(r.drift, []);
});

test('Contrato PAM · sonda: 401, 403, 404 y red caída detienen la prueba con un motivo claro', async () => {
  assert.match((await probe(answer(401))).stop_reason!, /401/);
  assert.match((await probe(answer(403))).stop_reason!, /403/);
  assert.match((await probe(answer(404))).stop_reason!, /no existe/);
  assert.match((await probe((async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch)).stop_reason!, /sin conexión/);
  for (const s of [401, 403]) assert.equal((await probe(answer(s))).ok, false);
});

test('Contrato PAM · sonda: permisos de escritura o tenant equivocado detienen la prueba', async () => {
  const w = await probe(answer(200, FX('auth_me_write')));
  assert.equal(w.ok, false);
  assert.match(w.stop_reason!, /escritura/);
  const other = await probe(answer(200, FX('auth_me_ok')), T2);
  assert.equal(other.ok, false);
  assert.match(other.stop_reason!, /tenant/);
});

test('Contrato PAM · sonda: si la forma real difiere de la supuesta se registra la diferencia y se adapta', async () => {
  const r = await probe(answer(200, FX('auth_me_alt')));
  assert.equal(r.ok, true, 'forma alternativa aceptada');
  assert.deepEqual(r.identity, { user_id: 'svc-crm-ro', client: '3', tenant: T });
  assert.ok(r.drift.some((d) => /userData/.test(d)) && r.drift.some((d) => /userAbilities/.test(d)));
  assert.deepEqual(r.read_subjects, ['players', 'transactions']);
});

test('Contrato PAM · validación: obligatorios, nulos, enumeraciones, fechas, ids, tenant y jugadores desconocidos', () => {
  const p = validateRows('players', FX('players'), { client: '3' });
  const codes = (rep: ReturnType<typeof validateRows>) => rep.issues.map((i) => `${i.id ?? '#' + i.row}:${i.field}:${i.code}`).sort();
  assert.deepEqual(codes(p), ['#8:id:missing', '9007:kyc_status:enum', '9008:created_at:date', '9010:client:tenant']);
  assert.equal(p.valid, 6, 'nulos en campos opcionales (país, KYC, JR) no son error');
  assert.deepEqual(p.unknown_fields, ['currency_iso'], 'campos que el CRM no usa quedan listados');
  const players = new Set<string>(FX('players').map((r: { id?: number }) => String(r.id)));
  const f = validateRows('financial', FX('financial'), { players });
  assert.deepEqual(codes(f), ['S-F7:transaction_type:enum', 'S-F8:amount:money', 'S-F8:player_id:unknown_player', 'S-F9:currency:missing']);
  const g = validateRows('games', FX('games'), { usernames: new Set<string>(FX('players').map((r: { username?: string }) => r.username).filter(Boolean)) });
  assert.deepEqual(codes(g), ['107:player:unknown_player', '108:transaction_type:enum']);
  assert.equal(validateRows('withdrawals', FX('withdrawals')).valid, 3);
  assert.equal(validateRows('players', [null, 'x']).issues.every((i) => i.code === 'type'), true);
});

test('Contrato PAM · mapeo: un jugador de otro cliente no entra al tenant', () => {
  const ctx = { tenant_id: T, brand_id: 'rumbawin', client: '3' };
  assert.equal(mapPlayer({ id: 1, client: 7, created_at: '2026-10-01' }, ctx).skipped[0].reason, 'jugador de otro cliente: no pertenece a este tenant');
  assert.equal(mapPlayer({ id: 1, client: { id: 3 }, created_at: '2026-10-01' }, ctx).events.length, 1);
  assert.equal(mapPlayer({ id: 1, created_at: '2026-10-01' }, ctx).events.length, 1, 'sin cliente en la fila: se acepta (lo garantiza el alcance de la credencial)');
});

test('Contrato PAM · corrida completa con fixtures: informe redactado, discrepancias con decisión y sin datos de otro cliente', async () => {
  const { app } = setup();
  const okProbe = await probe(answer(200, FX('auth_me_ok')));
  const source = new SandboxPam({ players: FX('players'), financial: FX('financial'), withdrawals: FX('withdrawals'), games: FX('games') }, { pageSize: 3 });
  const rep = await runPamContract({ mode: 'fixtures', probe: okProbe, source, ingestor: app.ingestor, tenant: T, brand: 'rumbawin', client: '3' });
  assert.equal(rep.verdict, 'con_discrepancias');
  assert.ok(rep.discrepancies.every((d) => d.decision && d.decision !== 'Revisar'), 'cada tipo de discrepancia tiene una decisión');
  assert.equal(app.ingestor.get(T, '9010'), undefined, 'jugador del cliente 7 descartado');
  assert.equal(app.ingestor.get(T, '9001')!.stats.deposits_minor, 5_000_000);
  assert.equal(app.ingestor.get(T, '9004')!.rg?.value, 'self_excluded');
  const text = JSON.stringify(rep);
  assert.ok(!text.includes(TOKEN) && !/@/.test(text), 'sin credencial ni correos en el informe');
  assert.ok(!text.includes('sint9001'), 'sin usernames en el informe: solo ids, campos y códigos');
  const stopped = await runPamContract({ mode: 'ss1', probe: await probe(answer(401)), source, ingestor: setup().app.ingestor, tenant: T, brand: 'rumbawin' });
  assert.deepEqual([stopped.verdict, stopped.sync.length], ['detenido', 0], 'sin identidad válida no se lee ningún dato');
});

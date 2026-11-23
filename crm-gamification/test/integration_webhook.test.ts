import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { sign, verifySignature, handleWebhook } from '../src/integration/webhook.ts';
import { createHandler } from '../src/api/server.ts';
import { setup, ev, T, T2 } from './helpers.ts';

const SECRET = 's3cr3t-'.repeat(6);
const now = Math.floor(Date.parse('2026-11-15T15:00:00Z') / 1000);

test('A4: firma HMAC con ventana de tiempo y comparación segura', () => {
  const body = '{"a":1}';
  assert.ok(verifySignature(SECRET, sign(SECRET, body, now), body, now).ok);
  assert.deepEqual(verifySignature(SECRET, sign(SECRET, body, now), body + ' ', now), { ok: false, status: 401, error: 'bad_signature' });
  assert.deepEqual(verifySignature(SECRET, sign('otro', body, now), body, now), { ok: false, status: 401, error: 'bad_signature' });
  assert.deepEqual(verifySignature(SECRET, sign(SECRET, body, now - 301), body, now), { ok: false, status: 401, error: 'stale_timestamp' });
  assert.deepEqual(verifySignature(SECRET, 'v1=abc', body, now), { ok: false, status: 401, error: 'bad_signature_header' });
});

test('A4: lote en vivo dispara recorridos; duplicados y otro tenant no', () => {
  const { app, clock } = setup('2026-11-15T15:00:00Z');
  const at = clock.now().toISOString();
  const reg = ev(T, 'w1', 'player.registered', { email_masked: 'x', country: 'CO', locale: 'es', timezone: 'America/Bogota' }, at);
  const body = JSON.stringify({ events: [reg, reg, ev(T2, 'w2', 'player.registered', { email_masked: 'x', country: 'CO', locale: 'es', timezone: 'America/Bogota' }, at), { foo: 1, tenant_id: T }] });
  const out = handleWebhook({ secrets: { [T]: SECRET }, tenantHeader: T, signatureHeader: sign(SECRET, body, now), rawBody: body, ingestor: app.ingestor, nowS: now });
  assert.equal(out.status, 200);
  const b = out.body as { applied: number; duplicates: number; rejected: number; results: { status: string; reason?: string }[] };
  assert.deepEqual([b.applied, b.duplicates, b.rejected], [1, 1, 2]);
  assert.equal(b.results[2].reason, 'tenant_mismatch');
  assert.equal(app.runtime.instances(T, { player_id: 'w1', journey_id: 'j1_verification' }).length, 1, 'modo live: entra al recorrido');
  assert.equal(app.ingestor.get(T2, 'w2'), undefined);
  assert.equal(handleWebhook({ secrets: { [T]: SECRET }, tenantHeader: 'nadie', signatureHeader: sign(SECRET, body, now), rawBody: body, ingestor: app.ingestor, nowS: now }).status, 401);
  const big = JSON.stringify({ events: Array.from({ length: 501 }, () => ({})) });
  assert.equal(handleWebhook({ secrets: { [T]: SECRET }, tenantHeader: T, signatureHeader: sign(SECRET, big, now), rawBody: big, ingestor: app.ingestor, nowS: now }).status, 413);
});

test('A4: endpoint HTTP no requiere token de usuario pero sí firma válida', async () => {
  const { app } = setup();
  const srv = createServer(createHandler(app, undefined, { devAuth: false, webhookSecrets: { [T]: SECRET } })).listen(0);
  const port = (srv.address() as { port: number }).port;
  try {
    const e = ev(T, 'h1', 'consent.changed', { purpose: 'marketing', channel: 'email', granted: true }, new Date().toISOString());
    const body = JSON.stringify(e);
    const post = (sig: string) => fetch(`http://127.0.0.1:${port}/api/ingest/ss1`, { method: 'POST', headers: { 'x-ss1-tenant': T, 'x-ss1-signature': sig, 'content-type': 'application/json' }, body });
    assert.equal((await post('t=1,v1=' + '0'.repeat(64))).status, 401);
    const ok = await post(sign(SECRET, body));
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { applied: number }).applied, 1);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/ingest/ss1`)).status, 405);
  } finally { srv.close(); }
});

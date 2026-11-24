import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { setup, onboard, T } from './helpers.ts';
import { route } from '../src/api/router.ts';
import { validateWebhookUrl, BACKOFF_MS, type HttpRequest } from '../src/integration/outbound.ts';
import { verifySignature } from '../src/integration/webhook.ts';
import { InMemoryBus } from '../src/integration/bus.ts';

const admin = { id: 'adm@ss1', tenant_id: T };

test('J2: solo destinos https públicos (sin SSRF)', () => {
  assert.equal(validateWebhookUrl('https://hooks.syssoft1.com/crm'), null);
  for (const u of ['http://hooks.syssoft1.com', 'https://localhost/x', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://svc.internal/x', 'https://intranet/x', 'https://u:p@hooks.syssoft1.com/', 'nope']) assert.ok(validateWebhookUrl(u), u);
});

test('J2: entrega firmada verificable por el receptor, sin datos personales, con id para deduplicar', async () => {
  const { app, clock } = setup();
  const sent: HttpRequest[] = [];
  app.webhooks.setTransport(async (r) => { sent.push(r); return { status: 200 }; });
  const sub = app.webhooks.create(admin, { url: 'https://hooks.syssoft1.com/crm', events: ['delivery.accepted', 'reward.confirmed'] });
  assert.match(sub.secret, /^whsec_[0-9a-f]{48}$/);
  assert.equal(app.webhooks.list(T)[0].secret_hint.endsWith('…'), true, 'el secreto no se vuelve a mostrar');
  onboard(app, clock, 'p'); // bienvenida ⇒ bono confirmado + avisos aceptados
  const r = await app.webhooks.dispatch();
  assert.ok(r.delivered >= 2, JSON.stringify(r));
  const types = sent.map((s) => s.headers['x-ss1-crm-event']);
  assert.ok(types.includes('reward.confirmed') && types.includes('delivery.accepted'));
  for (const s of sent) {
    const t = Number(/t=(\d+)/.exec(s.headers['x-ss1-crm-signature'])![1]);
    assert.equal(verifySignature(sub.secret, s.headers['x-ss1-crm-signature'], s.body, t).ok, true, 'el receptor verifica con el mismo esquema que la ingesta');
    assert.equal(s.headers['x-ss1-crm-signature'].split('v1=')[1], createHmac('sha256', sub.secret).update(`${t}.${s.body}`).digest('hex'));
    assert.equal(JSON.parse(s.body).id, s.headers['x-ss1-crm-delivery']);
    assert.ok(!/[\w.+-]+@[\w-]+\.[a-z]{2,}|a\*\*\*/i.test(s.body), 'sin emails ni contacto en el cuerpo');
  }
  assert.equal((await app.webhooks.dispatch()).sent, 0, 'lo entregado no se reenvía');
});

test('J2: reintentos con espera creciente, 4xx sin reintento, cola de muertos y desactivación tras fallos seguidos', async () => {
  const { app, clock } = setup();
  let code = 503;
  app.webhooks.setTransport(async () => ({ status: code }));
  const sub = app.webhooks.create(admin, { url: 'https://hooks.syssoft1.com/crm', events: ['policy.approved'] });
  app.audit.record(T, 'apr', 'policy.approved', 'CO/rumbawin', {});
  await app.webhooks.dispatch();
  const d = () => app.webhooks.deliveries(T)[0];
  assert.deepEqual([d().status, d().attempts], ['pending', 1]);
  assert.equal((await app.webhooks.dispatch()).sent, 0, 'espera antes de reintentar');
  for (const wait of BACKOFF_MS) { clock.advance(wait); await app.webhooks.dispatch(); }
  assert.deepEqual([d().status, d().attempts], ['dead', 6]);
  app.webhooks.retry(admin, d().id); code = 200; await app.webhooks.dispatch();
  assert.equal(d().status, 'delivered', 'reintento manual');
  code = 400; app.audit.record(T, 'apr', 'policy.approved', 'PE/rumbawin', {}); await app.webhooks.dispatch();
  assert.equal(app.webhooks.deliveries(T)[0].status, 'failed', '400 no se reintenta');
  code = 500;
  for (let i = 0; i < 20; i++) app.audit.record(T, 'apr', 'policy.approved', `X${i}`, {});
  await app.webhooks.dispatch();
  assert.equal(app.webhooks.list(T).find((s) => s.id === sub.id)!.status, 'disabled');
  assert.equal(app.audit.list(T, { action: 'webhook.auto_disabled' }).length, 1);
});

test('J2/J3: API con permisos, rotación de secreto y publicación en el bus de eventos', async () => {
  const { app } = setup();
  const call = (method: string, path: string, roles: string, body: Record<string, unknown> = {}) => route(app, { method, path, query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': roles, 'x-actor': `${roles}@ss1` }, body });
  assert.equal((await call('POST', '/webhooks', 'crm_analyst', { url: 'https://a.syssoft1.com/x', events: ['rg.case_opened'] })).status, 403);
  assert.equal((await call('POST', '/webhooks', 'tenant_admin', { url: 'https://a.syssoft1.com/x', events: ['nope'] })).status, 422);
  const c = (await call('POST', '/webhooks', 'tenant_admin', { url: 'https://a.syssoft1.com/x', events: ['rg.case_opened'] })).body as { id: string; secret: string };
  const rot = (await call('POST', `/webhooks/${c.id}/rotate`, 'tenant_admin')).body as { secret: string };
  assert.notEqual(rot.secret, c.secret);
  const list = (await call('GET', '/webhooks', 'crm_analyst')).body as { subscriptions: { secret?: string }[] };
  assert.equal(list.subscriptions[0].secret, undefined, 'el listado nunca expone el secreto');
  const bus = app.bus as InMemoryBus;
  const got: unknown[] = []; bus.subscribe(`crm.outbound.${T}`, (m) => got.push(m.value));
  app.audit.record(T, 'system', 'rg.case_opened', 'p1', { level: 'high' });
  assert.equal((got[0] as { type: string }).type, 'rg.case_opened', 'cada evento saliente también va al bus');
});

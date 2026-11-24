import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, seedTenant, ev } from '../src/app.ts';
import { ManualClock, DAY } from '../src/shared/util.ts';
import { setup, onboard, T } from './helpers.ts';
import { route } from '../src/api/router.ts';
import { smsSegments, SmsAdapter, WhatsAppAdapter, TelegramAdapter, type HttpRequest } from '../src/channels/providers.ts';

test('F2: segmentos SMS (GSM-7 vs UCS-2) y límite de 3 segmentos', () => {
  assert.deepEqual(smsSegments('Hola'), { encoding: 'GSM-7', segments: 1, length: 4 });
  assert.equal(smsSegments('a'.repeat(160)).segments, 1);
  assert.equal(smsSegments('a'.repeat(161)).segments, 2);
  assert.equal(smsSegments('€'.repeat(80)).length, 160, 'el euro cuenta doble en GSM-7');
  assert.equal(smsSegments('Límite 🎰').encoding, 'UCS-2');
  assert.equal(smsSegments('ó'.repeat(71)).segments, 2, 'UCS-2: 70 por segmento');
  const sent: HttpRequest[] = [];
  const sms = new SmsAdapter({ account: 'AC1', sender: 'BRAND' }, (r) => { sent.push(r); return { status: 201, body: '{"sid":"SM1"}' }; });
  assert.deepEqual(sms.send({ to: '+573001112233', body: 'x'.repeat(500), idempotency_key: 'k' }), { ok: false, reason: 'sms_too_long:4_segments_GSM-7', retryable: false });
  assert.deepEqual(sms.send({ to: '3001112233', body: 'hola', idempotency_key: 'k' }), { ok: false, reason: 'invalid_phone', retryable: false });
  assert.deepEqual(sms.send({ to: '+573001112233', body: 'largo', sms_body: 'corto', idempotency_key: 'k1' }), { ok: true, provider_message_id: 'SM1' });
  assert.match(sent[0].body, /Body=corto/, 'usa el texto SMS propio de la plantilla');
  assert.ok(!JSON.stringify(sent[0]).match(/authorization|token/i), 'sin secretos en la petición: los inyecta el gateway');
});

test('F2: WhatsApp exige plantilla aprobada; Telegram solo chats vinculados; errores del proveedor clasificados', () => {
  const ok = () => ({ status: 200, body: '{"messages":[{"id":"wamid.1"}]}' });
  const wa = new WhatsAppAdapter({ phone_number_id: '123' }, ok);
  assert.equal((wa.send({ to: '+573001112233', body: 'texto libre', idempotency_key: 'k' }) as { reason: string }).reason, 'whatsapp_template_not_approved');
  let body = '';
  const wa2 = new WhatsAppAdapter({ phone_number_id: '123' }, (r) => { body = r.body; return ok(); });
  assert.deepEqual(wa2.send({ to: '+573001112233', body: 'x', idempotency_key: 'k', whatsapp_template: { name: 'reward_granted_v1', lang: 'es' }, whatsapp_params: ['free_spins', '10.000'] }), { ok: true, provider_message_id: 'wamid.1' });
  assert.deepEqual(JSON.parse(body).template.components[0].parameters.map((p: { text: string }) => p.text), ['free_spins', '10.000']);
  const tg = new TelegramAdapter({ bot: 'BOT' }, () => ({ status: 200, body: '{"ok":true,"result":{"message_id":7}}' }));
  assert.equal((tg.send({ to: 'not-linked', body: 'x', idempotency_key: 'k' }) as { reason: string }).reason, 'telegram_chat_not_linked');
  assert.deepEqual(tg.send({ to: '123456', subject: 'Hola!', body: 'Vas al 50%.', idempotency_key: 'k' }), { ok: true, provider_message_id: '7' });
  const busy = new TelegramAdapter({ bot: 'BOT' }, () => ({ status: 429, body: '' }));
  assert.deepEqual(busy.send({ to: '1', body: 'x', idempotency_key: 'k' }), { ok: false, reason: 'provider_http_429', retryable: true });
  const unconfigured = new SmsAdapter({ account: 'AC', sender: 'B' });
  assert.deepEqual(unconfigured.send({ to: '+573001112233', body: 'x', idempotency_key: 'k' }), { ok: false, reason: 'provider_not_configured', retryable: false }, 'sin transporte no se simula como enviado');
});

test('F2: recorrido por SMS respeta consentimiento del canal, contacto resuelto por SS1 y tope por canal', () => {
  const clock = new ManualClock('2026-11-15T15:00:00Z');
  const app = createApp(clock, { demoProviders: true });
  seedTenant(app, T);
  const author = { id: 'ana@ss1', tenant_id: T, roles: ['crm_analyst' as const] };
  const approver = { id: 'apr@ss1', tenant_id: T, roles: ['approver' as const] };
  app.registry.saveDraft(author, { id: 'j_sms', brand_id: 'rumbawin', name: 'Depósito → SMS', purpose: 'marketing', trigger: { event_type: 'deposit.settled' }, entry: 'm', nodes: [{ id: 'm', type: 'message', channel: 'sms', template: 'loyalty_halfway', next: 'e' }, { id: 'e', type: 'exit' }] });
  app.registry.submit(author, 'j_sms'); app.registry.approve(approver, 'j_sms'); app.registry.publish(author, 'j_sms');
  const players = Array.from({ length: 30 }, (_, i) => `s${i}`);
  for (const p of players) {
    onboard(app, clock, p, T, { verify: false });
    app.ingestor.ingest(ev(T, p, 'consent.changed', { purpose: 'marketing', channel: 'sms', granted: p !== 's0' }, clock.now().toISOString()));
    app.ingestor.ingest(ev(T, p, 'deposit.settled', { deposit_id: `${p}d1`, amount_minor: 100_00, currency: 'COP' }, clock.now().toISOString()));
    app.ingestor.ingest(ev(T, p, 'deposit.settled', { deposit_id: `${p}d2`, amount_minor: 100_00, currency: 'COP' }, clock.now().toISOString()));
  }
  const rs = app.channels.receipts(T).filter((r) => r.channel === 'sms');
  assert.ok(rs.filter((r) => r.player_id === 's0').every((r) => r.status === 'suppressed' && /marketing_consent_revoked:sms/.test(r.reason ?? '')));
  const accepted = rs.filter((r) => r.status === 'accepted');
  const noContact = rs.filter((r) => r.reason === 'no_contact_for_sms');
  assert.ok(accepted.length > 10 && noContact.length > 0, `con y sin teléfono: ${accepted.length}/${noContact.length}`);
  assert.ok(new Set(accepted.map((r) => r.player_id)).size === accepted.length, 'tope de 1 SMS al día por jugador');
  assert.ok(rs.some((r) => r.reason?.includes('frequency_cap_channel:sms')));
  assert.equal(accepted[0].rendered?.body.includes('{{'), false);
});

test('F4: bandeja del jugador — entrega in-app, leídos, archivado, vigencia y permisos', async () => {
  const { app, clock } = setup();
  onboard(app, clock, 'p'); // la bienvenida otorga free spins ⇒ aviso in-app
  const box = app.adapters.inapp.list(T, 'p');
  assert.ok(box.items.length >= 1 && box.unread === box.items.length);
  assert.equal(box.items[0].category, 'promotional');
  const call = (method: string, path: string, roles: string) => route(app, { method, path, query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': roles, 'x-actor': 'x' }, body: {} });
  const id = encodeURIComponent(box.items[0].id);
  assert.equal((await call('POST', `/players/p/inbox/${id}/read`, 'crm_analyst')).status, 403, 'marketing no marca mensajes del jugador');
  assert.equal((await call('POST', `/players/p/inbox/${id}/read`, 'support')).status, 200);
  assert.equal(app.adapters.inapp.list(T, 'p').unread, box.items.length - 1);
  assert.equal((await call('POST', `/players/otro/inbox/${id}/read`, 'support')).status, 422, 'no se puede tocar la bandeja de otro jugador');
  await call('POST', `/players/p/inbox/${id}/archive`, 'support');
  assert.equal(app.adapters.inapp.list(T, 'p').items.length, box.items.length - 1);
  assert.equal(app.adapters.inapp.list(T, 'p', { include_archived: true }).items.length, box.items.length);
  clock.advance(15 * DAY);
  assert.equal(app.adapters.inapp.list(T, 'p').items.filter((i) => i.category === 'promotional').length, 0, 'promociones caducan a los 14 días');
  const inbox = (await call('GET', '/players/p/inbox', 'support')).body as { unread: number };
  assert.equal(typeof inbox.unread, 'number');
});

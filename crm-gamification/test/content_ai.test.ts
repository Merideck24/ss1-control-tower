import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, onboard, T } from './helpers.ts';
import { route } from '../src/api/router.ts';
import { moderate } from '../src/content/moderation.ts';
import { claudeWriter } from '../src/content/claudeWriter.ts';
import type { WriterFn } from '../src/content/studio.ts';

const brief = { key: 'reload_weekend', goal: 'Invitar a depositar el fin de semana para sumar puntos de nivel', purpose: 'marketing' as const, locales: ['es', 'en'] as ('es' | 'en')[], vars: ['level'], include_sms: true };

test('E6: la moderación bloquea promesas de ganancia, persecución de pérdidas, variables inventadas, enlaces externos y falta de aviso JR', () => {
  const codes = (t: Record<string, { subject?: string; body: string; sms?: string }>, purpose: 'marketing' | 'service' = 'marketing') => moderate(t, { purpose, allowedVars: ['level'] }).map((i) => `${i.severity}:${i.code}`);
  assert.deepEqual(codes({ es: { subject: 'Hola', body: 'Sube al nivel {{level}}. Juega con responsabilidad. +18' } }), []);
  const bad = codes({ es: { subject: 'GANANCIA SEGURA HOY', body: 'Recupera lo perdido con {{bonus}} en https://otro-sitio.com' } });
  for (const c of ['block:guaranteed_win', 'block:loss_chasing', 'block:unknown_variable', 'block:external_link', 'block:missing_rg_notice', 'warn:shouting']) assert.ok(bad.includes(c), `${c} en ${bad}`);
  assert.ok(codes({ es: { body: 'Pide un préstamo y juega. +18' } }).includes('block:credit_pressure'));
  assert.ok(codes({ es: { body: 'Escríbenos a ana@mail.com. +18' } }).includes('block:pii'));
  assert.ok(codes({ es: { body: 'Free spins solo hoy!!! Juega con responsabilidad.' } }).filter((c) => c.startsWith('warn')).length >= 2, 'gratis, urgencia y exclamaciones son avisos');
  assert.deepEqual(codes({ es: { body: 'Puedes activar la autoexclusión desde tu perfil.' } }, 'service'), [], 'servicio: sin aviso obligatorio ni bloqueo por mencionar autoexclusión');
  assert.ok(codes({ es: { body: 'x'.repeat(10), sms: 'y'.repeat(161) } }).includes('block:sms_too_long'));
  assert.ok(codes({ es: { body: 'Suma puntos esta semana.', sms: 'RumbaWin +18' } }).includes('block:missing_rg_notice'), 'el aviso en el SMS no cubre el texto');
});

test('E6: borrador → moderación → edición humana → aprobación por otra persona → plantilla usable', async () => {
  const { app, clock } = setup();
  const call = (method: string, path: string, roles: string, body: Record<string, unknown> = {}, write?: WriterFn) => route(app, { method, path, query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': roles, 'x-actor': `${roles}@ss1` }, body }, write ? { write } : {});
  const risky: WriterFn = async () => ({ source: 'claude', model: 'claude-opus-5-5', drafts: { es: { subject: 'Nivel {{level}}', body: 'Gana seguro este fin de semana.' }, en: { subject: 'Level {{level}}', body: 'Weekend points await. Play responsibly. 18+' } } });
  const r = await call('POST', '/content/drafts', 'crm_analyst', brief, risky);
  assert.equal(r.status, 201);
  const d = r.body as { id: string; moderation: { severity: string; code: string; locale: string }[]; source: string; model: string };
  assert.equal(d.source, 'claude'); assert.equal(d.model, 'claude-opus-5-5');
  assert.ok(d.moderation.some((i) => i.code === 'guaranteed_win' && i.locale === 'es'));
  assert.equal((await call('POST', `/content/drafts/${d.id}/submit`, 'crm_analyst')).status, 422, 'bloqueado por moderación');
  const fixed = await call('POST', `/content/drafts/${d.id}/edit`, 'tenant_admin', { texts: { es: { subject: 'Nivel {{level}}', body: 'Este fin de semana tus apuestas suman puntos hacia {{level}}. Juega con responsabilidad. +18', sms: 'RumbaWin: suma puntos hacia {{level}}. +18' } } });
  assert.equal((fixed.body as { moderation: { severity: string }[] }).moderation.filter((i) => i.severity === 'block').length, 0);
  assert.equal((await call('POST', `/content/drafts/${d.id}/submit`, 'crm_analyst')).status, 200);
  // quien editó tampoco aprueba; aprobador sí
  const self = await route(app, { method: 'POST', path: `/content/drafts/${d.id}/approve`, query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': 'approver', 'x-actor': 'tenant_admin@ss1' }, body: {} });
  assert.equal(self.status, 403);
  assert.equal((await call('POST', `/content/drafts/${d.id}/approve`, 'approver')).status, 200);
  const t = app.channels.template(T, 'reload_weekend')!;
  assert.equal(t.category, 'promotional');
  assert.ok(t.content.es!.body.includes('{{level}}') && t.channels?.sms?.es);
  assert.deepEqual(app.audit.list(T).filter((a) => a.action.startsWith('content.')).map((a) => a.action), ['content.generated', 'content.edited', 'content.submitted', 'content.approved']);
  // la plantilla aprobada se puede enviar en un recorrido
  onboard(app, clock, 'p');
  const rec = app.channels.send({ tenant_id: T, player_id: 'p', address: 'p', channel: 'inapp', template: 'reload_weekend', locale: 'es', vars: { level: 'Oro' }, idempotency_key: 'k1' });
  assert.equal(rec.status, 'accepted'); assert.match(rec.rendered!.body, /hacia Oro/);
  // sin IA: texto base, marcado como tal
  const base = await call('POST', '/content/drafts', 'crm_analyst', { ...brief, key: 'reload_base' });
  assert.equal((base.body as { source: string }).source, 'base');
  assert.equal((await call('POST', '/content/drafts', 'support', { ...brief, key: 'x_support' })).status, 403);
  assert.equal((await call('POST', '/content/drafts', 'crm_analyst', { ...brief, key: 'Bad Key' })).status, 422);
});

test('E6: el escritor con Claude pide salida estructurada, trata el pedido como dato y maneja el rechazo', async () => {
  const calls: Record<string, unknown>[] = [];
  const reply = (body: Record<string, unknown>) => ({ beta: { messages: { create: async (req: Record<string, unknown>) => { calls.push(req); return body; } } } });
  const ok = reply({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ es: { subject: 'Hola', body: 'Texto. Juega con responsabilidad. +18', sms: 'Hola +18' }, en: { subject: 'Hi', body: 'Text. Play responsibly. 18+', sms: 'Hi 18+' } }) }] });
  const w = claudeWriter(ok as never);
  const out = await w(brief);
  assert.equal(out.source, 'claude'); assert.equal(out.drafts.en?.subject, 'Hi');
  const req = calls[0] as { model: string; fallbacks: string; output_config: { effort: string; format: { type: string; schema: { required: string[]; properties: Record<string, { required: string[] }> } } }; system: string; messages: { content: string }[] };
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.fallbacks, 'default');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.deepEqual(req.output_config.format.schema.required, ['es', 'en']);
  assert.deepEqual(req.output_config.format.schema.properties.es.required, ['subject', 'body', 'sms']);
  assert.match(req.system, /Nunca prometas ganancias/);
  assert.match(req.messages[0].content, /^<pedido>\{.*\}<\/pedido>/s, 'el pedido viaja delimitado y en JSON');
  await assert.rejects(claudeWriter(reply({ model: 'm', stop_reason: 'refusal', content: [] }) as never)(brief), /rechazó/);
  await assert.rejects(claudeWriter(reply({ model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'no json' }] }) as never)(brief), /formato/);
});

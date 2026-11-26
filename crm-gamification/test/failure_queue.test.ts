/**
 * Cola de fallas y reproceso manual (Fase 2, incremento 2). Criterios de cierre:
 *  · un operador autorizado encuentra, entiende y reprocesa una falla recuperable;
 *  · un actor fuera de ámbito no puede verla ni ejecutarla;
 *  · dos solicitudes simultáneas no duplican el efecto.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/api/router.ts';
import { setup, onboard, ev, T, T2 } from './helpers.ts';

type R = { status: number; body: any };
function world() {
  const { app, clock } = setup();
  const call = (method: string, path: string, roles: string, body: Record<string, unknown> = {}, tenant = T, query = ''): Promise<R> =>
    route(app, { method, path, query: new URLSearchParams(query), headers: { 'x-tenant-id': tenant, 'x-roles': roles, 'x-actor': `${roles.split(',')[0]}@ss1` }, body }) as Promise<R>;
  // recorrido de servicio por email: depósito → aviso (sin topes de marketing que interfieran)
  const author = { id: 'ana@ss1', tenant_id: T, roles: ['crm_analyst' as const] }, approver = { id: 'beto@ss1', tenant_id: T, roles: ['approver' as const] };
  app.registry.saveDraft(author, { id: 'j_fail', brand_id: 'rumbawin', name: 'Aviso de depósito', purpose: 'service', trigger: { event_type: 'deposit.settled' }, entry: 'm', nodes: [{ id: 'm', type: 'message', channel: 'email', template: 'deposit_progress', next: 'e' }, { id: 'e', type: 'exit' }] });
  app.registry.submit(author, 'j_fail'); app.registry.approve(approver, 'j_fail'); app.registry.publish(approver, 'j_fail');
  onboard(app, clock, 'p1', T, { verify: false });
  const email = app.adapters.email as unknown as { failNext: number; timeoutNext: 'accepted' | 'lost' | null; lookupAvailable: boolean; rejectNext: string | null; outbox: { idempotency_key: string }[] };
  const deposit = (id = 'd1') => app.ingestor.ingest(ev(T, 'p1', 'deposit.settled', { deposit_id: id, amount_minor: 5_000_000, currency: 'COP' }, clock.now().toISOString()));
  const sentFor = (key: string) => email.outbox.filter((m) => m.idempotency_key === key).length;
  return { app, clock, call, email, deposit, sentFor, author, approver };
}

test('Cola de fallas: el operador encuentra la falla con su contexto y la entiende', async () => {
  const w = world();
  w.email.failNext = 10; // proveedor caído: agota los reintentos automáticos
  w.deposit();
  const list = await w.call('GET', '/failures', 'crm_analyst');
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  const f = list.body.items[0];
  assert.deepEqual([f.journey_id, f.version, f.node_id, f.channel, f.status, f.reason, f.attempts, f.class, f.brand_id], ['j_fail', 1, 'm', 'email', 'failed', 'provider_unavailable', 3, 'transitoria', 'rumbawin']);
  assert.ok(f.instance_id && f.key.startsWith(f.instance_id + ':'), 'la clave de idempotencia es instancia:paso');
  assert.match(f.reason_text, /no estaba disponible/);
  assert.ok(f.instructions.length >= 2 && /misma clave/.test(f.instructions.join(' ')));
  assert.equal(list.body.can_reprocess, true);
  // filtros
  assert.equal((await w.call('GET', '/failures', 'crm_analyst', {}, T, 'channel=sms')).body.total, 0);
  assert.equal((await w.call('GET', '/failures', 'crm_analyst', {}, T, 'journey=j_fail&status=transitoria')).body.total, 1);
  assert.equal((await w.call('GET', '/failures', 'crm_analyst', {}, T, 'from=2099-01-01')).body.total, 0);
  const one = await w.call('GET', `/failures/${encodeURIComponent(f.key)}`, 'crm_analyst');
  assert.equal(one.status, 200);
  assert.match(one.body.external_effect, /efecto externo/);
});

test('Cola de fallas: fuera de ámbito no ve ni ejecuta (rol sin permiso, auditor solo lee, otro tenant)', async () => {
  const w = world();
  w.email.failNext = 10; w.deposit();
  const key = (await w.call('GET', '/failures', 'crm_analyst')).body.items[0].key;
  assert.equal((await w.call('GET', '/failures', 'rg_officer')).status, 403, 'oficial de JR no ve la cola');
  const aud = await w.call('GET', '/failures', 'auditor');
  assert.deepEqual([aud.status, aud.body.can_reprocess], [200, false], 'auditor ve pero no reprocesa');
  assert.equal((await w.call('POST', `/failures/${encodeURIComponent(key)}/reprocess`, 'auditor', { reason: 'x', confirm: true })).status, 403);
  assert.equal((await w.call('POST', `/failures/${encodeURIComponent(key)}/reprocess`, 'support', { reason: 'x', confirm: true })).status, 403);
  assert.equal((await w.call('GET', '/failures', 'crm_analyst', {}, T2)).body.total, 0, 'otro tenant no la ve');
  assert.equal((await w.call('GET', `/failures/${encodeURIComponent(key)}`, 'crm_analyst', {}, T2)).status, 404);
  assert.equal((await w.call('POST', `/failures/${encodeURIComponent(key)}/reprocess`, 'tenant_admin', { reason: 'x', confirm: true }, T2)).status, 404, 'otro tenant no la ejecuta');
  assert.equal(w.sentFor(key), 0);
});

test('Reproceso: pide confirmación y motivo, reenvía con la misma clave y deja rastro', async () => {
  const w = world();
  w.email.failNext = 10; w.deposit();
  const key = (await w.call('GET', '/failures', 'crm_analyst')).body.items[0].key;
  const url = `/failures/${encodeURIComponent(key)}/reprocess`;
  const noConfirm = await w.call('POST', url, 'crm_analyst', { reason: 'proveedor recuperado' });
  assert.deepEqual([noConfirm.status, noConfirm.body.error], [422, 'confirmation_required']);
  assert.match(noConfirm.body.message, /efecto externo/);
  assert.equal((await w.call('POST', url, 'crm_analyst', { confirm: true })).status, 422, 'sin motivo no se reprocesa');
  w.email.failNext = 0;
  const ok = await w.call('POST', url, 'crm_analyst', { reason: 'proveedor recuperado', confirm: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.outcome, 'accepted');
  assert.equal(w.sentFor(key), 1);
  const rec = w.app.channels.receipt(T, key)!;
  assert.deepEqual([rec.status, rec.origin?.version, rec.attempts], ['accepted', 1, 4], 'misma clave, versión original, intentos acumulados');
  assert.equal((await w.call('GET', '/failures', 'crm_analyst')).body.total, 0, 'sale de la cola');
  const resolved = (await w.call('GET', '/failures', 'crm_analyst', {}, T, 'resolved=1')).body.items[0];
  assert.deepEqual([resolved.status, resolved.reason, resolved.class], ['resolved', 'provider_unavailable', 'transitoria'], 'la falla resuelta conserva su motivo original');
  assert.match(resolved.reason_text, /^Resuelta: quedó aceptada/);
  const hist = resolved.history;
  assert.deepEqual(hist.map((h: { actor: string; outcome: string; reason: string }) => [h.actor, h.outcome, h.reason]), [['crm_analyst@ss1', 'accepted', 'proveedor recuperado']]);
  const audit = w.app.audit.list(T).filter((a) => a.subject === key).map((a) => a.action);
  assert.deepEqual(audit, ['failure.reprocess_requested', 'failure.reprocessed']);
  assert.equal((await w.call('POST', url, 'crm_analyst', { reason: 'otra vez', confirm: true })).status, 409, 'una entrega aceptada no se reprocesa');
});

test('Reproceso: dos solicitudes simultáneas no duplican el efecto', async () => {
  const w = world();
  w.email.failNext = 10; w.deposit();
  const key = (await w.call('GET', '/failures', 'crm_analyst')).body.items[0].key;
  w.email.failNext = 0;
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  w.app.failures.beforeEffect = () => gate; // la primera queda dentro, como si escribiera en la base
  const url = `/failures/${encodeURIComponent(key)}/reprocess`;
  const a = w.call('POST', url, 'crm_analyst', { reason: 'a', confirm: true });
  const b = w.call('POST', url, 'tenant_admin', { reason: 'b', confirm: true });
  const rb = await b;
  assert.deepEqual([rb.status, rb.body.error], [409, 'reprocess_in_progress']);
  release();
  assert.equal((await a).body.outcome, 'accepted');
  assert.equal(w.sentFor(key), 1, 'un solo envío');
  const c = await w.call('POST', url, 'tenant_admin', { reason: 'c', confirm: true });
  assert.equal(c.status, 409, 'después ya no es una falla');
});

test('Reproceso de un envío incierto: concilia antes de reenviar', async () => {
  // el proveedor sí lo aceptó: se concilia sin reenviar
  let w = world();
  w.email.timeoutNext = 'accepted'; w.deposit();
  let f = (await w.call('GET', '/failures', 'crm_analyst')).body.items[0];
  assert.deepEqual([f.status, f.class], ['uncertain', 'incierta']);
  assert.match(f.external_effect, /concilia/);
  assert.equal(w.app.runtime.instances(T, { journey_id: 'j_fail' })[0].status, 'completed');
  let r = await w.call('POST', `/failures/${encodeURIComponent(f.key)}/reprocess`, 'crm_analyst', { reason: 'revisar timeout', confirm: true });
  assert.equal(r.body.outcome, 'reconciled_accepted');
  assert.equal(w.sentFor(f.key), 1, 'no se duplicó');
  // el proveedor no lo tenía: se reenvía una vez
  w = world();
  w.email.timeoutNext = 'lost'; w.deposit();
  f = (await w.call('GET', '/failures', 'crm_analyst')).body.items[0];
  r = await w.call('POST', `/failures/${encodeURIComponent(f.key)}/reprocess`, 'crm_analyst', { reason: 'revisar timeout', confirm: true });
  assert.equal(r.body.outcome, 'accepted');
  assert.equal(w.sentFor(f.key), 1);
  // el proveedor no puede confirmar: no se reenvía a ciegas
  w = world();
  w.email.timeoutNext = 'lost'; w.deposit(); w.email.lookupAvailable = false;
  f = (await w.call('GET', '/failures', 'crm_analyst')).body.items[0];
  r = await w.call('POST', `/failures/${encodeURIComponent(f.key)}/reprocess`, 'crm_analyst', { reason: 'revisar timeout', confirm: true });
  assert.equal(r.body.outcome, 'needs_reconciliation');
  assert.equal(w.sentFor(f.key), 0);
  assert.equal((await w.call('GET', '/failures', 'crm_analyst')).body.total, 1, 'sigue en la cola');
  // y un reintento automático del hub tampoco reenvía un incierto
  const rec = w.app.channels.receipt(T, f.key)!;
  w.app.channels.send({ tenant_id: T, player_id: 'p1', address: 'x', channel: 'email', template: rec.template, locale: 'es', vars: rec.vars!, idempotency_key: f.key });
  assert.equal(w.sentFor(f.key), 0);
});

test('Reproceso: revalida política y recorrido vigentes antes de ejecutar', async () => {
  const w = world();
  w.email.failNext = 10; w.deposit();
  const key = (await w.call('GET', '/failures', 'crm_analyst')).body.items[0].key;
  const url = `/failures/${encodeURIComponent(key)}/reprocess`;
  w.email.failNext = 0;
  // recorrido en pausa: no se reenvía
  w.app.registry.setPaused(w.author, 'j_fail', true, 'revisión');
  let r = await w.call('POST', url, 'crm_analyst', { reason: 'r', confirm: true });
  assert.deepEqual([r.body.outcome, w.sentFor(key)], ['blocked_by_journey', 0]);
  assert.match(r.body.detail, /pausa/);
  w.app.registry.setPaused(w.author, 'j_fail', false, 'ok');
  // el jugador se autoexcluyó entretanto: la política lo impide y la falla se cierra como suprimida
  w.app.ingestor.ingest(ev(T, 'p1', 'rg.status_changed', { status: 'self_excluded' }, w.clock.now().toISOString()));
  w.app.policy.markRgFeedSynced(T);
  const marketing = await w.app.failures.reprocess({ id: 'ana@ss1', tenant_id: T }, key, 'r');
  assert.equal(marketing.outcome, 'accepted', 'un mensaje de servicio sí se permite a un autoexcluido');
  // con un recorrido de marketing, la autoexclusión bloquea
  const w2 = world();
  w2.app.registry.saveDraft(w2.author, { id: 'j_mkt', brand_id: 'rumbawin', name: 'Promo', purpose: 'marketing', trigger: { event_type: 'deposit.settled' }, entry: 'm', nodes: [{ id: 'm', type: 'message', channel: 'email', template: 'deposit_progress', next: 'e' }, { id: 'e', type: 'exit' }] });
  w2.app.registry.submit(w2.author, 'j_mkt'); w2.app.registry.approve(w2.approver, 'j_mkt'); w2.app.registry.publish(w2.approver, 'j_mkt');
  w2.email.failNext = 100; w2.deposit();
  const mk = (await w2.call('GET', '/failures', 'crm_analyst', {}, T, 'journey=j_mkt')).body.items[0];
  w2.email.failNext = 0;
  w2.app.ingestor.ingest(ev(T, 'p1', 'rg.status_changed', { status: 'self_excluded' }, w2.clock.now().toISOString()));
  w2.app.policy.markRgFeedSynced(T);
  r = await w2.call('POST', `/failures/${encodeURIComponent(mk.key)}/reprocess`, 'crm_analyst', { reason: 'r', confirm: true });
  assert.equal(r.body.outcome, 'blocked_by_policy');
  assert.match(r.body.detail, /rg_restricted:self_excluded/);
  assert.equal(w2.sentFor(mk.key), 0);
  assert.equal(w2.app.channels.receipt(T, mk.key)!.status, 'suppressed');
});

test('Reproceso: conserva la versión original aunque se haya publicado otra', async () => {
  const w = world();
  w.email.failNext = 10; w.deposit();
  const key = (await w.call('GET', '/failures', 'crm_analyst')).body.items[0].key;
  w.app.registry.saveDraft(w.author, { id: 'j_fail', brand_id: 'rumbawin', name: 'Aviso de depósito v2', purpose: 'service', trigger: { event_type: 'deposit.settled' }, entry: 'm', nodes: [{ id: 'm', type: 'message', channel: 'inapp', template: 'deposit_progress', next: 'e' }, { id: 'e', type: 'exit' }] });
  w.app.registry.submit(w.author, 'j_fail'); w.app.registry.approve(w.approver, 'j_fail'); w.app.registry.publish(w.approver, 'j_fail');
  w.email.failNext = 0;
  const r = await w.app.failures.reprocess({ id: 'ana@ss1', tenant_id: T }, key, 'tras v2');
  assert.equal(r.outcome, 'accepted');
  const rec = w.app.channels.receipt(T, key)!;
  assert.deepEqual([rec.channel, rec.origin?.version], ['email', 1], 'se reenvía lo que definía la v1, no la v2');
});

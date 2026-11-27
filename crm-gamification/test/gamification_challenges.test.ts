/**
 * Flujo completo de gamificación: crear reto → aprobar → inscribir jugador sintético → recibir evento →
 * actualizar progreso → confirmar recompensa → desbloquear logro → generar tarjeta compartible.
 * Y los casos de borde: duplicados, secuencia, reversos, juego responsable, aislamiento entre tenants,
 * reconexión del tiempo real, versiones y bono pendiente que se confirma al conciliar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/api/router.ts';
import { setup, onboard, ev, T, T2 } from './helpers.ts';

type R = { status: number; body: any; contentType?: string };
const ANA = { id: 'ana@ss1', tenant_id: T }, BETO = { id: 'beto@ss1', tenant_id: T };
const SEASON = (clockIso: string) => ({ starts_at: new Date(Date.parse(clockIso) - 3_600_000).toISOString(), ends_at: new Date(Date.parse(clockIso) + 30 * 86_400_000).toISOString(), timezone: 'America/Bogota' });

function world() {
  const { app, clock } = setup();
  const call = (method: string, path: string, roles: string, body: Record<string, unknown> = {}, tenant = T): Promise<R> =>
    route(app, { method, path: path.split('?')[0], query: new URLSearchParams(path.split('?')[1] ?? ''), headers: { 'x-tenant-id': tenant, 'x-roles': roles, 'x-actor': `${roles.split(',')[0]}@ss1` }, body }) as Promise<R>;
  const now = () => clock.now().toISOString();
  let n = 0;
  const emit = (player: string, type: string, payload: Record<string, unknown>, id = `e${++n}`) => app.ingestor.ingest(ev(T, player, type as never, payload as never, now(), { event_id: id }));
  return { app, clock, call, now, emit };
}
const welcome = {
  id: 'reto_bienvenida', brand_id: 'rumbawin', name: 'Primeros pasos', description: 'Completa tu perfil, explora el sitio y juega tus primeras rondas',
  period: 'season', season: '2026-T4', mode: 'sequential', reward: { xp: 300, coins: 50 },
  steps: [
    { id: 'perfil', label: 'Completa tu perfil', kind: 'activity', action: 'profile_completed', target: 1 },
    { id: 'explora', label: 'Visita dos secciones del sitio', kind: 'activity', action: 'feature_visited', target: 2 },
    { id: 'juega', label: 'Juega 3 rondas de casino', kind: 'count', event_type: 'bet.settled', product: 'casino', target: 3 },
  ],
};

test('Gamificación · flujo completo: reto → aprobación → inscripción → evento → progreso → recompensa → logro → tarjeta', async () => {
  const w = world();
  onboard(w.app, w.clock, 'sint1');
  // 1. crear (analista) y aprobar (otra persona)
  const draft = await w.call('POST', '/challenges', 'crm_analyst', { ...welcome, ...SEASON(w.now()) });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  assert.equal((await w.call('POST', '/challenges/reto_bienvenida/submit', 'crm_analyst')).status, 200);
  assert.equal((await w.call('POST', '/challenges/reto_bienvenida/approve', 'crm_analyst,approver')).status, 403, 'autor ≠ aprobador');
  const ok = await w.call('POST', '/challenges/reto_bienvenida/approve', 'approver');
  assert.deepEqual([ok.status, ok.body.status], [200, 'active']);
  assert.ok(ok.body.approval_signature);
  // 2. el jugador se inscribe (participación voluntaria)
  const en = await w.call('POST', '/players/sint1/challenges/reto_bienvenida/enroll', 'support', { notify: true });
  assert.equal(en.status, 200, JSON.stringify(en.body));
  // 3. eventos: en secuencia, una apuesta antes de completar el perfil no cuenta
  w.emit('sint1', 'bet.settled', { bet_id: 'b0', stake: { amount_minor: 100_000, currency: 'COP' }, product: 'casino' });
  let v = (await w.call('GET', '/players/sint1/challenges', 'support')).body.find((c: { id: string }) => c.id === 'reto_bienvenida');
  assert.deepEqual(v.steps.map((s: { value: number }) => s.value), [0, 0, 0], 'el paso en curso es el perfil');
  w.emit('sint1', 'player.activity', { action: 'profile_completed' }, 'act-1');
  w.emit('sint1', 'player.activity', { action: 'profile_completed' }, 'act-1'); // duplicado: mismo event_id
  w.emit('sint1', 'player.activity', { action: 'feature_visited', feature: 'torneos' });
  w.emit('sint1', 'player.activity', { action: 'feature_visited', feature: 'tienda' });
  for (const id of ['b1', 'b2']) w.emit('sint1', 'bet.settled', { bet_id: id, stake: { amount_minor: 100_000, currency: 'COP' }, product: 'casino' });
  w.emit('sint1', 'bet.settled', { bet_id: 'w1', stake: { amount_minor: 0, currency: 'COP' }, win: { amount_minor: 50_000, currency: 'COP' }, product: 'casino' }); // premio: no es apuesta
  v = (await w.call('GET', '/players/sint1/challenges', 'support')).body.find((c: { id: string }) => c.id === 'reto_bienvenida');
  assert.deepEqual(v.steps.map((s: { value: number }) => s.value), [1, 2, 2]);
  assert.equal(v.completed_at, null);
  w.emit('sint1', 'bet.settled', { bet_id: 'b3', stake: { amount_minor: 100_000, currency: 'COP' }, product: 'casino' });
  v = (await w.call('GET', '/players/sint1/challenges', 'support')).body.find((c: { id: string }) => c.id === 'reto_bienvenida');
  // 4. recompensa confirmada: XP en el libro de fidelidad y monedas
  assert.ok(v.completed_at);
  assert.equal(v.reward_state.status, 'confirmed');
  assert.ok(w.app.loyalty.movements(T, 'sint1').some((m) => m.reason === 'challenge:reto_bienvenida' && m.points === 300));
  assert.ok(w.app.store.ledger(T, 'sint1').some((m) => m.amount === 50));
  // 5. logros desbloqueados: Retador (bronce) y Perfil completo; Explorador bronce (2 secciones)
  const mine = (await w.call('GET', '/players/sint1/achievements', 'support')).body.achievements;
  const got = Object.fromEntries(mine.filter((a: { level: unknown }) => a.level).map((a: { id: string; level: { label: string } }) => [a.id, a.level.label]));
  assert.deepEqual(got, { retador: 'Bronce', perfil_completo: 'Único', explorador: 'Bronce' });
  // 6. tarjeta compartible: sin alias autorizado no muestra nombre; con alias, sí; nunca montos
  let card = await w.call('POST', '/players/sint1/achievements/retador/card', 'support');
  assert.equal(card.status, 200);
  assert.match(card.body.svg, /Un jugador/);
  assert.doesNotMatch(card.body.svg, /\$|COP|saldo|dep[oó]sito|apuesta|sint1/i, 'sin montos, saldos, apuestas ni id del jugador');
  assert.equal((await w.call('POST', '/players/sint1/alias', 'support', { alias: 'LaRumbera', show_on_cards: true })).status, 200);
  card = await w.call('POST', '/players/sint1/achievements/retador/card', 'support');
  assert.match(card.body.svg, /LaRumbera/);
  assert.match(card.body.svg, /#062B3D/i, 'identidad visual de SS1');
  // 7. tiempo real: los avisos llegan en orden y se pueden recuperar desde un cursor
  const rt = (await w.call('GET', '/players/sint1/realtime?after=0', 'support')).body;
  const types = rt.events.map((e: { type: string }) => e.type);
  for (const t of ['challenge.progress', 'challenge.step_done', 'challenge.completed', 'reward.status', 'achievement.unlocked']) assert.ok(types.includes(t), t);
  const mid = rt.events[2].id;
  const again = (await w.call('GET', `/players/sint1/realtime?after=${mid}`, 'support')).body;
  assert.deepEqual(again.events.map((e: { id: number }) => e.id), rt.events.filter((e: { id: number }) => e.id > mid).map((e: { id: number }) => e.id), 'reanudación sin perder ni duplicar');
  // auditoría del ciclo
  const acts = w.app.audit.list(T).map((a) => a.action);
  for (const a of ['challenge.draft_saved', 'challenge.submitted', 'challenge.approved', 'challenge.enrolled', 'challenge.completed', 'achievement.unlocked', 'player.alias_set']) assert.ok(acts.includes(a), a);
});

test('Gamificación · enlace público opaco, voluntario y revocable; métricas separadas', async () => {
  const w = world();
  onboard(w.app, w.clock, 'sint2');
  w.app.achievements.recordActivity(T, 'rumbawin', 'sint2', 'profile_completed');
  const link = await w.call('POST', '/players/sint2/achievements/perfil_completo/share-link', 'support', { confirm: true });
  assert.equal(link.status, 200, JSON.stringify(link.body));
  assert.match(link.body.id, /^[A-Za-z0-9_-]{22}$/, 'identificador opaco');
  assert.doesNotMatch(link.body.id, /sint2|perfil/);
  assert.equal((await w.call('POST', '/players/sint2/achievements/perfil_completo/share-link', 'support', {})).status, 422, 'exige acción explícita');
  const pub = await w.call('GET', `/public/share/${link.body.id}`, '');
  assert.equal(pub.status, 200);
  assert.match(String(pub.body), /<svg/);
  await w.call('POST', '/players/sint2/share-events', 'support', { type: 'share_click', achievement_id: 'perfil_completo' });
  await w.call('POST', '/players/sint2/share-events', 'support', { type: 'download', achievement_id: 'perfil_completo' });
  const noEvidence = await w.call('POST', '/players/sint2/share-events', 'support', { type: 'post_confirmed', achievement_id: 'perfil_completo' });
  assert.equal(noEvidence.status, 422, 'publicación confirmada solo con evidencia del canal');
  const m = (await w.call('GET', '/gamification/share-metrics', 'crm_analyst')).body.find((x: { achievement_id: string }) => x.achievement_id === 'perfil_completo');
  assert.deepEqual([m.share_click, m.download, m.visit, m.post_confirmed, m.links_active], [1, 1, 1, 0, 1]);
  assert.equal((await w.call('POST', `/players/sint2/share-links/${link.body.id}/revoke`, 'support')).status, 200);
  assert.equal((await w.call('GET', `/public/share/${link.body.id}`, '')).status, 404, 'revocado: deja de verse');
  // sin logro no hay tarjeta
  assert.equal((await w.call('POST', '/players/sint2/achievements/retador/card', 'support')).status, 422);
});

test('Gamificación · validación con salvaguardas de juego responsable', async () => {
  const w = world();
  const daily = { ...welcome, id: 'reto_diario', period: 'daily', mode: 'single', steps: [{ id: 'dep', label: 'Deposita hoy', kind: 'sum', event_type: 'deposit.settled', target: 5_000_000 }], ...SEASON(w.now()) };
  const r1 = await w.call('POST', '/challenges', 'crm_analyst', daily);
  assert.equal(r1.status, 422);
  assert.match(r1.body.message, /diario no puede pedir depósitos/);
  const chase = { ...welcome, id: 'reto_malo', description: 'Recupera tus pérdidas de ayer', ...SEASON(w.now()) };
  assert.match((await w.call('POST', '/challenges', 'crm_analyst', chase)).body.message, /recuperar pérdidas/);
  assert.equal((await w.call('POST', '/challenges', 'support', { ...welcome, ...SEASON(w.now()) })).status, 403, 'soporte no crea retos');
});

test('Gamificación · exclusión: autoexcluido no se inscribe; una señal de riesgo suspende sin premio', async () => {
  const w = world();
  onboard(w.app, w.clock, 'ok1'); onboard(w.app, w.clock, 'rg1');
  w.emit('rg1', 'rg.status_changed', { status: 'self_excluded' });
  w.app.challenges.saveDraft(ANA, { ...welcome, ...SEASON(w.now()) } as never);
  w.app.challenges.submit(ANA, 'reto_bienvenida'); w.app.challenges.approve(BETO, 'reto_bienvenida');
  const r = await w.call('POST', '/players/rg1/challenges/reto_bienvenida/enroll', 'support', {});
  assert.equal(r.status, 422);
  assert.match(r.body.message, /rg_restricted/);
  w.app.challenges.enroll(T, 'ok1', 'reto_bienvenida', false);
  w.emit('ok1', 'rg.risk_signal', { level: 'high', score: 0.9, signals: ['night_sessions'] });
  w.emit('ok1', 'player.activity', { action: 'profile_completed' });
  const v = w.app.challenges.playerView(T, 'ok1').find((c) => c.id === 'reto_bienvenida')!;
  assert.deepEqual([v.enrollment_status, v.suspended_reason, v.steps[0].value], ['suspended', 'vulnerability_signal', 0]);
  assert.ok(v.ineligible.includes('vulnerability_signal'));
});

test('Gamificación · reverso de un depósito: compensa el paso y el XP ya otorgado', async () => {
  const w = world();
  onboard(w.app, w.clock, 'dep1');
  w.app.challenges.saveDraft(ANA, { ...welcome, id: 'reto_temp', mode: 'single', reward: { xp: 200 }, steps: [{ id: 'd', label: 'Deposita 100.000 en la temporada', kind: 'sum', event_type: 'deposit.settled', target: 10_000_000 }], ...SEASON(w.now()) } as never);
  w.app.challenges.submit(ANA, 'reto_temp'); w.app.challenges.approve(BETO, 'reto_temp');
  w.app.challenges.enroll(T, 'dep1', 'reto_temp', false);
  w.emit('dep1', 'deposit.settled', { deposit_id: 'D1', amount_minor: 10_000_000, currency: 'COP' });
  let v = w.app.challenges.playerView(T, 'dep1').find((c) => c.id === 'reto_temp')!;
  assert.equal(v.reward_state?.status, 'confirmed');
  w.emit('dep1', 'deposit.reversed', { deposit_id: 'D1', amount_minor: 10_000_000, currency: 'COP' });
  v = w.app.challenges.playerView(T, 'dep1').find((c) => c.id === 'reto_temp')!;
  assert.equal(v.reward_state?.status, 'reversed');
  assert.equal(v.steps[0].value, 0);
  const xp = w.app.loyalty.movements(T, 'dep1').filter((m) => m.ref.includes('reto_temp')).reduce((s, m) => s + m.points, 0);
  assert.equal(xp, 0, 'asiento compensatorio: el XP neto vuelve a cero');
});

test('Gamificación · bono pendiente: queda «pendiente» y pasa a «confirmado» al conciliar', async () => {
  const w = world();
  onboard(w.app, w.clock, 'bon1');
  w.app.challenges.saveDraft(ANA, { ...welcome, id: 'reto_bono', mode: 'single', reward: { reward_id: 'welcome_fs_10' }, steps: [{ id: 'p', label: 'Completa tu perfil', kind: 'activity', action: 'profile_completed', target: 1 }], ...SEASON(w.now()) } as never);
  w.app.challenges.submit(ANA, 'reto_bono'); w.app.challenges.approve(BETO, 'reto_bono');
  w.app.challenges.enroll(T, 'bon1', 'reto_bono', true);
  (w.app.bonus as unknown as { timeoutNext: number }).timeoutNext = 1;
  w.emit('bon1', 'player.activity', { action: 'profile_completed' });
  let v = w.app.challenges.playerView(T, 'bon1').find((c) => c.id === 'reto_bono')!;
  assert.equal(v.reward_state?.status, 'pending', 'sin confirmación del servicio de bonos no se da por otorgado');
  w.app.rewards.reconcile(T);
  v = w.app.challenges.playerView(T, 'bon1').find((c) => c.id === 'reto_bono')!;
  assert.equal(v.reward_state?.status, 'confirmed');
});

test('Gamificación · aislamiento entre tenants, versiones fijadas y reconexión con resync', async () => {
  const w = world();
  onboard(w.app, w.clock, 'iso1');
  w.app.challenges.saveDraft(ANA, { ...welcome, ...SEASON(w.now()) } as never);
  w.app.challenges.submit(ANA, 'reto_bienvenida'); w.app.challenges.approve(BETO, 'reto_bienvenida');
  assert.equal((await w.call('GET', '/challenges', 'crm_analyst', {}, T2)).body.items.length, 0, 'otro tenant no ve el reto');
  assert.equal((await w.call('POST', '/players/iso1/challenges/reto_bienvenida/enroll', 'support', {}, T2)).status, 404);
  w.app.challenges.enroll(T, 'iso1', 'reto_bienvenida', false);
  // v2 aprobada: quien ya estaba sigue en v1 durante el período
  w.app.challenges.saveDraft(ANA, { ...welcome, name: 'Primeros pasos v2', steps: [welcome.steps[0]], ...SEASON(w.now()) } as never);
  w.app.challenges.submit(ANA, 'reto_bienvenida'); w.app.challenges.approve(BETO, 'reto_bienvenida');
  const v = w.app.challenges.playerView(T, 'iso1').find((c) => c.id === 'reto_bienvenida')!;
  assert.deepEqual([v.version, v.steps.length], [1, 3]);
  // reconexión tras perder más de 200 avisos: pide releer el estado completo
  for (let i = 0; i < 250; i++) w.app.realtime.publish(T, 'iso1', 'challenge.progress', { i });
  assert.equal(w.app.realtime.since(T, 'iso1', 5).resync, true);
  assert.equal(w.app.realtime.since(T, 'iso1', w.app.realtime.since(T, 'iso1').last - 3).events.length, 3);
  assert.equal(w.app.realtime.since(T2, 'iso1').events.length, 0, 'los avisos no cruzan tenants');
});

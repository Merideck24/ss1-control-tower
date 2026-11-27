/** Robustez: ninguna operación responde 5xx ante datos vacíos o mal formados; flujos que fallaban en el recorrido. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/api/router.ts';
import { CATALOG } from '../src/api/catalog.ts';
import { seedDemoMissions } from '../src/demoAcquisition.ts';
import { setup, onboard, T } from './helpers.ts';

const BAD: Record<string, unknown>[] = [{}, { player_id: 12, amount_minor: 'mucho', option: null, rules: 'nope', nodes: 'x', paused: 'quizá', scopes: 'todo', policy: [], prizes: 'x', options: 'x' }];
const fill = (pattern: string, v: string) => pattern.replace(/\(([^()]+)\)/g, (_m, inner: string) => (/^[\w-]+(\|[\w-]+)+$/.test(inner) ? inner.split('|')[0] : v)).replace(/\\\//g, '/');

test('Robustez: las 128 operaciones responden 4xx (nunca 5xx) a datos vacíos, mal formados o parámetros inválidos', async () => {
  const { app, clock } = setup();
  onboard(app, clock, 'p1');
  seedDemoMissions(app, T, clock.now().getTime());
  const bad: string[] = [];
  for (const e of CATALOG) {
    const [method, pattern] = e.route.split(' ');
    for (const id of ['p1', 'no-existe']) {
      const path = fill(pattern, id);
      for (const body of method === 'GET' ? [{}] : BAD) {
        for (const q of method === 'GET' ? ['', 'days=abc&limit=-5&from=nope'] : ['']) {
          const r = await route(app, { method, path, query: new URLSearchParams(q), headers: { 'x-tenant-id': T, 'x-roles': 'tenant_admin,approver,rg_officer', 'x-actor': 'qa@ss1' }, body: body as Record<string, unknown> }).catch((err: Error) => ({ status: 599, body: err.message }));
          if (r.status >= 500) bad.push(`${r.status} ${method} ${path}?${q} ${JSON.stringify(body).slice(0, 40)} → ${JSON.stringify(r.body).slice(0, 100)}`);
        }
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('Recorrido: el simulador de un recorrido de depósito usa un ejemplo con monto y moneda', async () => {
  const { app, clock } = setup();
  onboard(app, clock, 'p1', T, { verify: false }); // sin bono de bienvenida: no consume el tope diario
  const author = { id: 'ana@ss1', tenant_id: T, roles: ['crm_analyst' as const] };
  app.registry.saveDraft(author, { id: 'j_dep', brand_id: 'rumbawin', name: 'Depósito → aviso', purpose: 'marketing', trigger: { event_type: 'deposit.settled' }, entry: 'm', nodes: [{ id: 'm', type: 'message', channel: 'inapp', template: 'deposit_progress', next: 'e' }, { id: 'e', type: 'exit' }] });
  const r = await route(app, { method: 'POST', path: '/journeys/j_dep/simulate', query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': 'crm_analyst', 'x-actor': 'ana@ss1' }, body: { player_id: 'p1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  const step = (r.body as { trace: { type: string; detail?: { vars?: Record<string, string> } }[] }).trace.find((t) => t.type === 'message');
  assert.match(String(step?.detail?.vars?.amount), /^\$\s?50\.000$/);
});

test('Recorrido: una misión con incentivo que se pausó se puede reanudar sin otra aprobación', async () => {
  const { app, clock } = setup();
  seedDemoMissions(app, T, clock.now().getTime());
  const call = (path: string, roles: string) => route(app, { method: 'POST', path, query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': roles, 'x-actor': `${roles}@ss1` }, body: {} });
  assert.equal(app.gamification.get(T, 'm_casino_20')!.status, 'active');
  assert.equal((await call('/gamification/missions/m_casino_20/pause', 'crm_analyst')).status, 200);
  const r = await call('/gamification/missions/m_casino_20/activate', 'crm_analyst');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(app.gamification.get(T, 'm_casino_20')!.status, 'active');
  assert.ok(app.audit.list(T).some((a) => a.action === 'mission.resumed'));
  // editar una misión que ya no es borrador: el mensaje dice qué pasa y qué hacer
  const m = app.gamification.get(T, 'm_casino_20')!;
  const save = await route(app, { method: 'POST', path: '/gamification/missions', query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': 'crm_analyst', 'x-actor': 'ana@ss1' }, body: { ...m } as never });
  assert.equal(save.status, 422);
  assert.match((save.body as { message: string }).message, /ya está activa: solo se editan borradores\. Para una misión nueva usa otro id\./);
});

test('Formularios: catálogo de campos con tipos y valores, y reglas como frases', async () => {
  const { app } = setup();
  const r = await route(app, { method: 'GET', path: '/segments/fields', query: new URLSearchParams('detail=1'), headers: { 'x-tenant-id': T, 'x-roles': 'crm_analyst', 'x-actor': 'ana@ss1' }, body: {} });
  const meta = r.body as { field: string; label: string; type: string; values?: [string, string][] }[];
  const by = Object.fromEntries(meta.map((m) => [m.field, m]));
  assert.deepEqual([by.kyc.type, by.kyc.label, by.kyc.values?.map(([v]) => v)], ['enum', 'KYC', ['pending', 'verified', 'rejected']]);
  assert.equal(by['stats.deposits_minor'].type, 'money');
  assert.equal(by['pred.churn'].type, 'prob');
  assert.equal(by['consent.marketing.email'].type, 'bool');
  assert.ok(meta.every((m) => m.label && m.type), 'todos los campos tienen nombre y tipo');
  // sin detail sigue respondiendo la lista de siempre
  const plain = await route(app, { method: 'GET', path: '/segments/fields', query: new URLSearchParams(), headers: { 'x-tenant-id': T, 'x-roles': 'crm_analyst', 'x-actor': 'ana@ss1' }, body: {} });
  assert.ok(Array.isArray(plain.body) && typeof (plain.body as unknown[])[0] === 'string');
  const { ruleText } = await import('../src/segments/ruleText.ts');
  // es-CO separa «$» de la cifra con un espacio duro: se acepta cualquier espacio
  assert.match(ruleText({ and: [{ field: 'lifecycle', op: 'eq', value: 'en_riesgo' }, { field: 'stats.deposits_minor', op: 'gte', value: 50_000_000 }, { field: 'pred.churn', op: 'gte', value: 0.6 }] }),
    /^Etapa del ciclo de vida es En riesgo y Depósitos acumulados al menos \$\s500\.000 y Probabilidad de abandono al menos 60 %$/);
});

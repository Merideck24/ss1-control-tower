/**
 * Vistas nativas del admin (Vue 3 + Vuetify, base de Vuexy): se compilan con el
 * compilador oficial de SFC, se empaquetan con esbuild y se renderizan en servidor con
 * Vue y Vuetify reales: contra una API simulada y contra el servidor real del CRM.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { build, type Plugin } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import { setup, onboard, T } from './helpers.ts';
import { createHandler } from '../src/api/server.ts';
import { renderEndpoints } from '../src/api/adminClientGen.ts';

const KIT = new URL('../integrations/ss1-admin/crm/', import.meta.url);
const OUT = new URL('./.tmp/admin-kit.mjs', import.meta.url);

const vuePlugin: Plugin = {
  name: 'vue-sfc',
  setup(b) {
    b.onLoad({ filter: /\.vue$/ }, async (args) => {
      const src = await readFile(args.path, 'utf8');
      const { descriptor, errors } = parse(src, { filename: args.path });
      if (errors.length) throw errors[0];
      const out = compileScript(descriptor, { id: args.path, inlineTemplate: true, isProd: true });
      return { contents: out.content, loader: 'ts' };
    });
    b.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let kit: any;
before(async () => {
  await mkdir(new URL('./.tmp/', import.meta.url), { recursive: true });
  const entry = new URL('./.tmp/admin-entry.ts', import.meta.url);
  await writeFile(entry, `
    export { createSSRApp, h } from 'vue';
    export { renderToString } from '@vue/server-renderer';
    export { createVuetify } from 'vuetify';
    export * as components from 'vuetify/components';
    export { createCrmClient, CrmApiError } from '${new URL('api/client.ts', KIT).pathname}';
    export { installCrm, CRM_VIEWS } from '${new URL('plugin.ts', KIT).pathname}';
    export { CRM_CLIENT } from '${new URL('composables/useCrm.ts', KIT).pathname}';
    export { default as CrmControlTower } from '${new URL('pages/CrmControlTower.vue', KIT).pathname}';
    export { default as CrmResponsibleGaming } from '${new URL('pages/CrmResponsibleGaming.vue', KIT).pathname}';
    export { default as CrmPolicies } from '${new URL('pages/CrmPolicies.vue', KIT).pathname}';
    export { default as CrmIntegrations } from '${new URL('pages/CrmIntegrations.vue', KIT).pathname}';
  `);
  await build({ entryPoints: [entry.pathname], bundle: true, format: 'esm', platform: 'node', outfile: OUT.pathname, plugins: [vuePlugin], logLevel: 'silent',
    define: { __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false', 'process.env.NODE_ENV': '"production"' } });
  kit = await import(`${OUT.href}?v=${Date.now()}`);
});

/** Renderiza una vista con un cliente dado y espera a que carguen sus consultas. */
async function render(View: unknown, client: unknown) {
  const vuetify = kit.createVuetify({ components: kit.components, ssr: true });
  const app = kit.createSSRApp({ render: () => kit.h(View) });
  app.use(vuetify);
  app.provide(kit.CRM_CLIENT, client);
  return kit.renderToString(app); // onServerPrefetch espera las consultas iniciales
}

test('Kit Vue: el mapa de operaciones generado está al día con el catálogo', async () => {
  assert.equal(await readFile(new URL('api/endpoints.generated.ts', KIT), 'utf8'), renderEndpoints(), 'corre `npm run admin:client`');
});

test('Kit Vue: cliente — URL /api/v1 con parámetros codificados, token Bearer, errores tipados y 401', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let unauthorized = 0;
  const fake = (status: number, body: unknown) => async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); };
  const c = kit.createCrmClient({ baseUrl: 'https://crm.syssoft1.com/', getToken: () => 'tok', fetchImpl: fake(200, { ok: 1 }), onUnauthorized: () => unauthorized++ });
  assert.equal(c.url('postRiskRgCasesCaseIdAction', { params: { case_id: 'rg-a/b', action: 'close' } }), 'https://crm.syssoft1.com/api/v1/risk/rg-cases/rg-a%2Fb/close');
  assert.equal(c.url('getPerformance', { query: { days: 30, brand: '' } }), 'https://crm.syssoft1.com/api/v1/performance?days=30');
  await c.call('postRuntimePause', { body: { paused: true } });
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer tok');
  assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.body, '{"paused":true}');
  assert.throws(() => c.url('getPlayersPlayerId', {}), /Falta el parámetro «player_id»/);
  const bad = kit.createCrmClient({ baseUrl: 'https://crm', getToken: () => 'x', fetchImpl: fake(401, { error: 'invalid_token', message: 'Sesión vencida' }), onUnauthorized: () => unauthorized++ });
  await assert.rejects(bad.call('getSession'), (e: { status: number; code: string; message: string }) => e.status === 401 && e.code === 'invalid_token' && e.message === 'Sesión vencida');
  assert.equal(unauthorized, 1);
});

test('Kit Vue: las 4 vistas nativas renderizan con Vuetify y datos simulados; los botones dependen de permisos', async () => {
  const fixtures: Record<string, unknown> = {
    getSession: { actor: { id: 'a', tenant_id: T, roles: ['rg_officer'] }, permissions: ['rg.act', 'rg.monitor', 'runtime.global_pause'] },
    getControlTower: { as_of: '2026-11-24T10:00:00Z', global_pause: false, brand: null, latency: { n: 5000, p50_ms: 0.04, p95_ms: 0.2, p99_ms: 0.5, slo_p95_ms: 250, within_slo: true }, journeys: [{ id: 'j1', name: 'Bienvenida', version: 2, status: 'published', purpose: 'marketing', control_group_pct: 10, instances: { completed: 12 } }], deliveries: { 'inapp:accepted': 40, 'email:suppressed': 3 }, suppression_reasons: { frequency_cap: 3 }, deferred: 1, dead_letters: 0, budgets: [{ reward_id: 'welcome', budget_minor: 1000_00, committed_minor: 900_00, remaining_minor: 100_00 }], alerts: [] },
    getRiskRgMonitor: { summary: { open: 1, high: 1, medium: 0, in_review: 0, closed: 0, marketing_on_hold: 1 }, signals: [{ code: 'loss_chasing', label: 'Persecución de pérdidas', cases: 1 }], interventions: { started: 1, messages_accepted: 2, messages_not_sent: 0 }, cases: [{ case_id: 'c1', player_id: 'p-77', level: 'high', score: 65, signals: [{ code: 'loss_chasing', label: 'Persecución de pérdidas', detail: '3 veces en 24 h', points: 35 }], opened_at: '2026-11-24T09:00:00Z', status: 'open', notes: [] }], note: 'nota' },
    getPolicies: { policies: [{ version: 'co-1', brand_id: 'rumbawin', market: 'CO', channels_enabled: ['inapp', 'email'], max_marketing_per_day: 2, quiet_hours: { start: 22, end: 8 }, incentives_allowed: true, require_kyc_for_incentives: true, rg_feed_max_staleness_ms: 21_600_000, history: [], pending: 1 }], proposals: [{ id: 'pp1', market: 'CO', brand_id: 'rumbawin', base_version: 'co-1', proposed: { version: 'co-2' }, changes: [{ field: 'max_marketing_per_day', from: 2, to: 3, loosens: true }], justification: 'Resolución nueva', status: 'pending', proposed_by: 'jr' }], note: 'n' },
    getIntegrationServiceKeys: { keys: [{ key_id: 'abc', name: 'PAM', scopes: ['events:write'], created_by: 'adm', created_at: '2026-11-24T08:00:00Z' }], note: 'k' },
    getWebhooks: { events: [], subscriptions: [], recent: [], note: 'w' },
  };
  const client = { call: async (op: string) => fixtures[op] ?? {}, url: () => '' };
  const tower = await render(kit.CrmControlTower, client);
  assert.match(tower, /Control Tower/); assert.match(tower, /Bienvenida/); assert.match(tower, /0,2 ms/); assert.match(tower, /Pausa general/, 'rg_officer puede pausar');
  const rg = await render(kit.CrmResponsibleGaming, client);
  assert.match(rg, /p-77/); assert.match(rg, /Persecución de pérdidas/); assert.match(rg, />\s*Tomar\s*</);
  const pol = await render(kit.CrmPolicies, client);
  assert.match(pol, /Máx\. marketing al día/); assert.match(pol, /Relaja una protección/);
  assert.doesNotMatch(pol, /Aprobar y aplicar/, 'sin journeys.approve no aparece el botón de aprobar');
  const integ = await render(kit.CrmIntegrations, client);
  assert.match(integ, /PAM/); assert.match(integ, /events:write/);
  assert.doesNotMatch(integ, /Crear llave/, 'sin integration.sync no se crean llaves');
  assert.deepEqual([...kit.CRM_VIEWS.native], ['control-tower', 'responsible-gaming', 'policies', 'integrations']);
});

test('Kit Vue: Control Tower nativa contra el servidor real del CRM (llave de servicio)', async () => {
  const { app, clock } = setup();
  onboard(app, clock, 'p1');
  const k = app.serviceKeys.create({ id: 'adm', tenant_id: T }, { name: 'Admin SS1', scopes: ['analytics:read'] });
  const srv = createServer(createHandler(app, undefined, { devAuth: false }));
  await new Promise<void>((r) => srv.listen(0, r));
  try {
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const client = kit.createCrmClient({ baseUrl: base, getToken: () => k.key });
    const tower = await client.call('getControlTower');
    assert.equal(tower.global_pause, false); assert.ok(tower.journeys.length >= 5);
    await assert.rejects(client.call('getPolicies'), (e: { status: number }) => e.status === 403, 'la llave no tiene policies:read');
    const html = await render(kit.CrmControlTower, { call: (op: string, o: unknown) => (op === 'getSession' ? Promise.resolve({ permissions: [] }) : client.call(op, o)), url: client.url });
    assert.match(html, /Verificado → free spins de bienvenida/);
    assert.doesNotMatch(html, /Pausa general/, 'sin permiso, sin botón');
  } finally { srv.close(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import { createCrmBridge, type CrmSession, type EventHost } from '../integrations/ss1-admin/crmBridge.ts';

function fakeHost() {
  const ls = new Set<(e: { origin: string; source?: unknown; data: unknown }) => void>();
  const host: EventHost = { addEventListener: (_t, l) => ls.add(l), removeEventListener: (_t, l) => ls.delete(l) };
  return { host, emit: (e: { origin: string; source?: unknown; data: unknown }) => ls.forEach((l) => l(e)), size: () => ls.size };
}

test('A6: puente del admin: sesión al ready, enlace directo, filtros de origen y fuente', () => {
  const sent: { msg: Record<string, unknown>; origin: string }[] = [];
  const frame = { postMessage: (msg: unknown, origin: string) => sent.push({ msg: msg as Record<string, unknown>, origin }) };
  let token = 'tok-' + 'a'.repeat(20);
  const session = (): CrmSession => ({ accessToken: token, tenantId: 'tenant-rumbawin', user: { id: '7' }, abilities: [{ action: 'read', subject: 'crm' }] });
  const titles: string[] = []; const heights: number[] = [];
  const { host, emit, size } = fakeHost();
  const b = createCrmBridge(host, { crmOrigin: 'https://crm.syssoft1.com', target: () => frame, getSession: session, initialTab: 'loyalty', onTitle: (t) => titles.push(t), onResize: (h) => heights.push(h) });
  emit({ origin: 'https://evil.example.com', source: frame, data: { type: 'ss1-crm:ready' } });
  emit({ origin: 'https://crm.syssoft1.com', source: {}, data: { type: 'ss1-crm:ready' } });
  assert.equal(sent.length, 0, 'ni otro origen ni otra ventana reciben la sesión');
  emit({ origin: 'https://crm.syssoft1.com', source: frame, data: { type: 'ss1-crm:ready' } });
  assert.deepEqual(sent.map((s) => [s.msg.type, s.origin]), [['ss1-crm:session', 'https://crm.syssoft1.com'], ['ss1-crm:navigate', 'https://crm.syssoft1.com']]);
  assert.equal(sent[0].msg.version, 1); assert.equal(sent[1].msg.tab, 'loyalty');
  emit({ origin: 'https://crm.syssoft1.com', source: frame, data: { type: 'ss1-crm:ready' } });
  assert.equal(sent.filter((s) => s.msg.type === 'ss1-crm:navigate').length, 1, 'el enlace directo se aplica una vez');
  token = 'tok-' + 'b'.repeat(20); b.refreshSession();
  assert.equal(sent.at(-1)!.msg.accessToken, token);
  emit({ origin: 'https://crm.syssoft1.com', source: frame, data: { type: 'ss1-crm:title', title: 'Perfil 360', tab: 'profile' } });
  emit({ origin: 'https://crm.syssoft1.com', source: frame, data: { type: 'ss1-crm:resize', height: 10 } });
  emit({ origin: 'https://crm.syssoft1.com', source: frame, data: { type: 'ss1-crm:resize', height: 1e9 } });
  assert.deepEqual([titles, heights], [['Perfil 360'], [300, 50_000]]);
  b.navigate('../../etc'); b.navigate('audit');
  assert.equal(sent.at(-1)!.msg.tab, 'audit');
  b.dispose(); assert.equal(size(), 0);
});

test('A6: sin sesión el puente no envía nada', () => {
  const sent: unknown[] = [];
  const { host, emit } = fakeHost();
  createCrmBridge(host, { crmOrigin: 'https://crm.syssoft1.com', target: () => ({ postMessage: (m: unknown) => sent.push(m) }), getSession: () => null });
  emit({ origin: 'https://crm.syssoft1.com', data: { type: 'ss1-crm:ready' } });
  assert.equal(sent.length, 0);
});

test('A6: el componente Vue compila con el compilador oficial', () => {
  const src = readFileSync('integrations/ss1-admin/CrmGamificationPage.vue', 'utf8');
  const { descriptor, errors } = parse(src, { filename: 'CrmGamificationPage.vue' });
  assert.deepEqual(errors, []);
  const script = compileScript(descriptor, { id: 'crm' });
  assert.match(script.content, /createCrmBridge/);
  const tpl = compileTemplate({ source: descriptor.template!.content, filename: 'CrmGamificationPage.vue', id: 'crm', compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(tpl.errors, []);
  const perms = JSON.parse(readFileSync('integrations/ss1-admin/permissions.json', 'utf8'));
  assert.deepEqual(perms.sujetos_nuevos.map((x: { subject: string }) => x.subject), ['crm', 'crm-approval', 'responsible-gaming', 'crm-settings']);
});

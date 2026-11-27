/**
 * Tiempo real y tarjeta pública contra el servidor real (web + worker + PostgreSQL):
 * el canal SSE entrega el progreso al momento, reanuda desde Last-Event-ID sin perder avisos, y el
 * enlace público de una tarjeta se abre sin sesión y deja de abrirse al revocarlo.
 */
import { expect, test } from '@playwright/test';
import { api, event } from '../lib/stack.ts';
import { main, uid } from './_main.ts';

const H = (role: string) => ({ 'x-tenant-id': 'tenant-rumbawin', 'x-roles': role, 'x-actor': `${role}@ss1` });

/** Lee el canal SSE hasta juntar `n` eventos o agotar el tiempo. */
async function readSse(base: string, player: string, lastId: number, n: number, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const res = await fetch(`${base}/api/players/${player}/stream`, { headers: { ...H('support'), 'last-event-id': String(lastId) }, signal: ctrl.signal });
  expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
  const rd = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
  const got: { id: number; type: string }[] = [];
  try {
    while (got.length < n) {
      const { value, done } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const d = /^data: (.+)$/m.exec(b)?.[1]; if (d) got.push(JSON.parse(d)); }
    }
  } catch { /* tiempo agotado */ } finally { clearTimeout(t); ctrl.abort(); }
  return got;
}

test('Tiempo real: SSE entrega el progreso al momento y reanuda desde Last-Event-ID', async () => {
  const { base } = main();
  const p = uid('rt');
  for (const [t, pl, i] of [['player.registered', { email_masked: 'r***@x.test', country: 'CO', locale: 'es', timezone: 'America/Bogota' }, 1], ['rg.status_changed', { status: 'none' }, 2]] as const)
    expect((await api(base, 'tenant_admin', 'POST', '/events', event(t, p, pl, `${p}-${i}`))).status).toBeLessThan(300);
  expect((await api(base, 'support', 'POST', `/players/${p}/challenges/reto_primeros_pasos/enroll`, { notify: true })).status).toBe(200);
  // conectados al canal: el evento del sitio llega como aviso de progreso
  const live = readSse(base, p, 0, 2);
  await new Promise((r) => setTimeout(r, 300));
  await api(base, 'tenant_admin', 'POST', '/events', event('player.activity', p, { action: 'profile_completed' }, `${p}-a1`));
  const first = await live;
  expect(first.map((e) => e.type)).toEqual(expect.arrayContaining(['challenge.progress', 'challenge.step_done']));
  // desconectados: llegan dos avisos más; al reconectar con el último id se reciben solo los nuevos
  const lastSeen = Math.max(...first.map((e) => e.id));
  await api(base, 'tenant_admin', 'POST', '/events', event('player.activity', p, { action: 'feature_visited', feature: 'torneos' }, `${p}-a2`));
  const resumed = await readSse(base, p, lastSeen, 1);
  expect(resumed.length).toBeGreaterThan(0);
  expect(resumed.every((e) => e.id > lastSeen), 'sin duplicados al reanudar').toBe(true);
  // otro tenant no puede abrir el canal de este jugador
  const other = await fetch(`${base}/api/players/${p}/stream`, { headers: { ...H('support'), 'x-tenant-id': 'tenant-demo-b' } });
  expect(other.status).toBe(404);
});

test('Tarjeta pública: se abre sin sesión con identificador opaco y deja de abrirse al revocar', async () => {
  const { base } = main();
  const p = uid('sh');
  for (const [t, pl, i] of [['player.registered', { email_masked: 's***@x.test', country: 'CO', locale: 'es', timezone: 'America/Bogota' }, 1], ['rg.status_changed', { status: 'none' }, 2], ['player.activity', { action: 'profile_completed' }, 3]] as const)
    await api(base, 'tenant_admin', 'POST', '/events', event(t, p, pl, `${p}-${i}`));
  const al = await api(base, 'support', 'POST', `/players/${p}/alias`, { alias: 'Publico_1', show_on_cards: true });
  expect(al.status, JSON.stringify(al.body)).toBe(200);
  const link = await api(base, 'support', 'POST', `/players/${p}/achievements/perfil_completo/share-link`, { confirm: true });
  expect(link.status, JSON.stringify(link.body)).toBe(200);
  const pub = await fetch(`${base}${link.body.url}`);
  expect(pub.status, await pub.clone().text()).toBe(200);
  expect(pub.headers.get('content-type')).toMatch(/text\/html/);
  expect(pub.headers.get('x-robots-tag')).toBe('noindex');
  const html = await pub.text();
  expect(html).toMatch(/Publico_1/);
  expect(html).not.toMatch(new RegExp(p));
  expect((await api(base, 'support', 'POST', `/players/${p}/share-links/${link.body.id}/revoke`)).status).toBe(200);
  expect((await fetch(`${base}${link.body.url}`)).status).toBe(404);
});

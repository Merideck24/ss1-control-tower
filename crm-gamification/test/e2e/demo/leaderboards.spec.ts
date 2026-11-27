// Clasificaciones en el navegador: pestaña del backoffice con páginas y empates; bloque «Clasificación» en el
// teléfono del jugador con su fila, sin ids, y la opción de ocultarse; axe y 390 px.
import { test } from '@playwright/test';
import { AXE, DEMO_URL, finish } from '../lib/env.ts';
const PAGE = DEMO_URL;
const out: string[] = []; const ok = (id: string, c: boolean, d = '') => out.push(`${c ? 'OK  ' : 'FAIL'} ${id} ${d}`);
const settle = (p: import('@playwright/test').Page) => p.waitForFunction(() => !/Cargando…/.test(document.querySelector('#view')?.textContent ?? ''), null, { timeout: 60000 });
const axeRun = async (p: import('@playwright/test').Page) => { await p.addScriptTag({ content: AXE }); return p.evaluate(async () => (await (window as any).axe.run('#view')).violations.map((v: any) => `${v.id}(${v.nodes.length}) ${v.nodes[0].html.slice(0, 90)}`)); };
test('Clasificaciones: backoffice paginado y fila propia del jugador, con opción de ocultarse', async ({ browser }) => {
  test.setTimeout(180_000);
  const errs: string[] = [];
  const p = await browser.newPage({ viewport: { width: 1280, height: 950 } }); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(PAGE + '#/clasificaciones?rol=crm_analyst'); await p.waitForSelector('#lbf', { timeout: 60000 }); await settle(p);
  const txt = await p.innerText('#view');
  ok('L.1', (await p.inputValue('#lbf select')) === 'tournament:t_sports_week' && /Posición/i.test(txt), 'clasificación del torneo sembrado');
  ok('L.2', /queda arriba quien/.test(txt), 'regla de desempate visible');
  const pages = await p.$('[data-lbp]:not([disabled])');
  if (pages) { await pages.click(); await settle(p); ok('L.3', /Página 2/.test(await p.innerText('#view')), 'paginación'); } else ok('L.3', true, 'una sola página');
  let vs = await axeRun(p); ok('L.axe', vs.length === 0, vs.join(' | ') || 'sin violaciones');
  // jugador con posición en el torneo
  await p.goto(PAGE + '#/fidelidad?rol=support'); await p.reload(); await p.waitForSelector('#lpq', { timeout: 60000 });
  const pid = await p.evaluate(async () => { const h = { 'x-tenant-id': 'tenant-rumbawin', 'x-roles': 'support', 'x-actor': 'qa@ss1' }; const ps = await (await fetch('/api/players?sort=recent', { headers: h })).json(); for (const x of ps) { const l = await (await fetch(`/api/players/${x.player_id}/leaderboards`, { headers: h })).json(); if (l.boards.some((b: any) => b.type === 'tournament' && b.position)) return x.player_id; } return null; });
  ok('J.0', !!pid, `jugador en la clasificación: ${pid}`);
  await p.fill('#lpq', pid!); await p.dispatchEvent('#lpq', 'change'); await p.waitForSelector('#gamx .glb li.me', { timeout: 30000 });
  const phone = await p.innerText('#gamx');
  ok('J.1', /Clasificación/.test(phone) && /Tú \(/.test(phone), 'fila propia resaltada');
  ok('J.2', !(await p.innerHTML('#gamx .glb')).includes(pid!), 'el sitio no muestra ids de jugador');
  await p.check('#ghide'); await p.waitForFunction(() => /Tú \(Jugador oculto\)/.test(document.querySelector('#gamx')?.textContent ?? ''), null, { timeout: 10000 });
  ok('J.3', true, 'ocultarse: sigue contando como «Jugador oculto»');
  vs = await axeRun(p); ok('J.axe', vs.length === 0, vs.join(' | ') || 'sin violaciones');
  const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await m.goto(PAGE + '#/clasificaciones?rol=crm_analyst'); await m.waitForSelector('#lbf', { timeout: 60000 }); await settle(m);
  ok('mob.clasif', (await m.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1, 'sin desborde a 390 px');
  console.log(out.join('\n')); console.log('errores JS:', errs.join(' | ') || 'ninguno'); finish(out, errs);
});

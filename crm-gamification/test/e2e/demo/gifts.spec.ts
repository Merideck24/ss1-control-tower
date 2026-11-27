// Regalos instantáneos en el navegador: crear (analista), aprobar y entregar (aprobador), «Mis regalos»
// en el teléfono del jugador, reclamar una sola vez, axe y 390 px.
import { test } from '@playwright/test';
import { AXE, DEMO_URL, finish } from '../lib/env.ts';
const PAGE = DEMO_URL;
const out: string[] = []; const ok = (id: string, c: boolean, d = '') => out.push(`${c ? 'OK  ' : 'FAIL'} ${id} ${d}`);
const settle = (p: import('@playwright/test').Page) => p.waitForFunction(() => !/Cargando…/.test(document.querySelector('#view')?.textContent ?? ''), null, { timeout: 60000 });
const axeRun = async (p: import('@playwright/test').Page) => { await p.addScriptTag({ content: AXE }); return p.evaluate(async () => (await (window as any).axe.run('#view')).violations.map((v: any) => `${v.id}(${v.nodes.length}) ${v.nodes[0].html.slice(0, 90)}`)); };
test('Regalos: crear, aprobar y entregar, Mis regalos, reclamar una vez', async ({ browser }) => {
  test.setTimeout(180_000);
  const errs: string[] = [];
  const p = await browser.newPage({ viewport: { width: 1280, height: 950 } }); p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => d.accept('fin de la prueba'));
  await p.goto(PAGE + '#/regalos?rol=crm_analyst'); await p.waitForSelector('#gfnew', { timeout: 60000 }); await settle(p);
  ok('G.1', /Regalo de temporada/.test(await p.innerText('#view')), 'regalo sembrado con métricas');
  await p.fill('#gfnew [name=name]', 'Regalo UI'); await p.fill('#gfnew [name=message]', 'Un detalle de prueba');
  await p.click('#gfnew button[type=submit]'); await p.waitForTimeout(900);
  ok('G.2', /guardado/.test(await p.innerText('#flash')), await p.innerText('#flash'));
  await p.click('[data-gfa="submit"][data-gid="regalo_regalo_ui"]'); await p.waitForTimeout(600);
  ok('G.3', !(await p.$('[data-gfa="approve"]')), 'el analista no ve «Aprobar»');
  let vs = await axeRun(p); ok('G.axe', vs.length === 0, vs.join(' | ') || 'sin violaciones');
  await p.goto(PAGE + '#/regalos?rol=approver'); await p.reload(); await p.waitForSelector('[data-gfa="approve"]', { timeout: 60000 });
  await p.click('[data-gfa="approve"][data-gid="regalo_regalo_ui"]'); await p.waitForTimeout(700);
  ok('G.4', /lo recibi/.test(await p.innerText('#flash')), await p.innerText('#flash'));
  // jugador con el regalo de temporada disponible
  await p.goto(PAGE + '#/fidelidad?rol=support'); await p.reload(); await p.waitForSelector('#lpq', { timeout: 60000 });
  const pid = await p.evaluate(async () => { const h = { 'x-tenant-id': 'tenant-rumbawin', 'x-roles': 'support', 'x-actor': 'qa@ss1' }; const ps = await (await fetch('/api/players?sort=recent', { headers: h })).json(); for (const x of ps) { const gs = await (await fetch(`/api/players/${x.player_id}/gifts`, { headers: h })).json(); if (gs.some((g: any) => g.gift_id === 'regalo_temporada' && g.status === 'available')) return x.player_id; } return null; });
  ok('J.0', !!pid, `jugador con regalo disponible: ${pid}`);
  await p.fill('#lpq', pid!); await p.dispatchEvent('#lpq', 'change'); await p.waitForSelector('#gamx [data-gclaim="regalo_temporada"]', { timeout: 30000 });
  ok('J.1', /Mis regalos[\s\S]*Regalo de temporada/.test(await p.innerText('#gamx')), 'aparece en «Mis regalos»');
  await p.click('#gamx [data-gclaim="regalo_temporada"]');
  await p.waitForFunction(() => /Reclamado/.test(document.querySelector('#gamx')?.textContent ?? ''), null, { timeout: 10000 });
  ok('J.2', !(await p.$('#gamx [data-gclaim="regalo_temporada"]')), 'ya no se puede reclamar de nuevo');
  const again = await p.evaluate(async (id) => { const h = { 'x-tenant-id': 'tenant-rumbawin', 'x-roles': 'support', 'x-actor': 'qa@ss1', 'content-type': 'application/json' }; const r = await fetch(`/api/players/${id}/gifts/regalo_temporada/claim`, { method: 'POST', headers: h, body: '{}' }); return (await r.json()).status; }, pid);
  ok('J.3', again === 'claimed', 'reclamar otra vez devuelve el mismo resultado');
  vs = await axeRun(p); ok('J.axe', vs.length === 0, vs.join(' | ') || 'sin violaciones');
  const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await m.goto(PAGE + '#/regalos?rol=crm_analyst'); await m.waitForSelector('#gfnew', { timeout: 60000 }); await settle(m);
  ok('mob.regalos', (await m.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1, 'sin desborde a 390 px');
  console.log(out.join('\n')); console.log('errores JS:', errs.join(' | ') || 'ninguno'); finish(out, errs);
});

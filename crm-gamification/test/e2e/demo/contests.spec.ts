// Concursos en el navegador: concurso sembrado abierto, el jugador participa aceptando las bases, el analista
// revisa y descalifica con motivo, cierra y sortea; el aprobador aprueba ganadores; verificación del sorteo;
// aviso de mecanismo no autorizado; axe y 390 px.
import { test } from '@playwright/test';
import { AXE, DEMO_URL, finish } from '../lib/env.ts';
const PAGE = DEMO_URL;
const out: string[] = []; const ok = (id: string, c: boolean, d = '') => out.push(`${c ? 'OK  ' : 'FAIL'} ${id} ${d}`);
const settle = (p: import('@playwright/test').Page) => p.waitForFunction(() => !/Cargando…/.test(document.querySelector('#view')?.textContent ?? ''), null, { timeout: 60000 });
const axeRun = async (p: import('@playwright/test').Page) => { await p.addScriptTag({ content: AXE }); return p.evaluate(async () => (await (window as any).axe.run('#view')).violations.map((v: any) => `${v.id}(${v.nodes.length}) ${v.nodes[0].html.slice(0, 90)}`)); };
const H = { 'x-tenant-id': 'tenant-rumbawin', 'x-roles': 'support', 'x-actor': 'qa@ss1' };
const C = 'concurso_fin_de_ano';

test('Concursos: participar, revisar, sortear, aprobar ganadores y verificar', async ({ browser }) => {
  test.setTimeout(180_000);
  const errs: string[] = [];
  const p = await browser.newPage({ viewport: { width: 1280, height: 950 } }); p.on('pageerror', (e) => errs.push(e.message));
  const answers: string[] = ['rules_breach', 'Participación de prueba fuera de las bases'];
  p.on('dialog', (d) => d.accept(answers.shift() ?? 'fin de la prueba'));
  // jugador: participa desde el teléfono
  await p.goto(PAGE + '#/fidelidad?rol=support'); await p.waitForSelector('#lpq', { timeout: 60000 });
  const pids: string[] = await p.evaluate(async ([h, cid]) => {
    const ps = await (await fetch('/api/players?sort=recent', { headers: h as Record<string, string> })).json(); const found: string[] = [];
    for (const x of ps) { const cs = await (await fetch(`/api/players/${x.player_id}/contests`, { headers: h as Record<string, string> })).json(); if (cs.some((c: any) => c.id === cid && !c.entered && !c.ineligible.length)) found.push(x.player_id); if (found.length === 3) break; }
    return found;
  }, [H, C] as const);
  ok('J.0', pids.length === 3, `jugadores elegibles: ${pids.join(', ')}`);
  const form = `#gamx [data-center="${C}"]`;
  await p.fill('#lpq', pids[0]); await p.dispatchEvent('#lpq', 'change'); await p.waitForSelector(form, { timeout: 30000 });
  await p.click(`${form} button`); await p.waitForTimeout(300);
  ok('J.1', !!(await p.$(form)), 'sin aceptar las bases no participa');
  await p.check(`${form} [name=accept]`); await p.click(`${form} button`);
  await p.waitForFunction(() => /Ya participas/.test(document.querySelector('#gamx')?.textContent ?? ''), null, { timeout: 10000 });
  ok('J.2', true, 'participación registrada');
  let vs = await axeRun(p); ok('J.axe', vs.length === 0, vs.join(' | ') || 'sin violaciones');
  // dos participaciones más por la API del sitio
  await p.evaluate(async ([h, ids, cid]) => { for (const id of ids as string[]) await fetch(`/api/players/${id}/contests/${cid}/enter`, { method: 'POST', headers: { ...(h as Record<string, string>), 'content-type': 'application/json' }, body: JSON.stringify({ accept_rules: true }) }); }, [H, pids.slice(1), C] as const);
  // analista: revisa, descalifica con motivo, cierra y sortea
  const row = `[data-cout="${C}"]`;
  await p.goto(PAGE + '#/concursos?rol=crm_analyst'); await p.reload(); await p.waitForSelector(`[data-copen="${C}"]`, { timeout: 60000 }); await settle(p);
  ok('B.1', /no es un mecanismo autorizado/i.test(await p.innerText('#view')), 'aviso del mecanismo de sorteo de demostración');
  await p.click(`[data-copen="${C}"]`); await p.waitForSelector(`${row} [data-cdq]`);
  ok('B.2', (await p.$$(`${row} [data-cdq]`)).length === 3, '3 participaciones válidas');
  await p.click(`${row} [data-cdq="${pids[2]}"]`); await p.waitForSelector(`${row} [data-crs]`, { timeout: 10000 });
  ok('B.3', /Incumple las bases: Participación de prueba/.test(await p.innerText(row)), 'descalificación con código y motivo visible');
  vs = await axeRun(p); ok('B.axe', vs.length === 0, vs.join(' | ') || 'sin violaciones');
  await p.click(`[data-cna="close"][data-cid="${C}"]`);
  await p.waitForSelector(`[data-cna="draw"][data-cid="${C}"]`, { timeout: 10000 });
  await p.click(`[data-cna="draw"][data-cid="${C}"]`); await p.waitForTimeout(700);
  ok('B.4', /Sorteo hecho: 2 ganadores propuestos/.test(await p.innerText('#flash')), await p.innerText('#flash'));
  ok('B.5', !(await p.$('[data-cna="approve-winners"]')), 'el analista no aprueba ganadores');
  // aprobador: verifica y aprueba
  await p.goto(PAGE + '#/concursos?rol=approver'); await p.reload(); await p.waitForSelector(`[data-cproof="${C}"]`, { timeout: 60000 });
  await p.click(`[data-cproof="${C}"]`); await p.waitForSelector(`${row} .simres`);
  const proof = await p.innerText(row);
  ok('A.1', /coinciden/.test(proof) && /mismos ganadores/.test(proof), 'compromiso y reproducción verificados');
  await p.click(`[data-cna="approve-winners"][data-cid="${C}"]`); await p.waitForTimeout(700);
  ok('A.2', /premios entregados/.test(await p.innerText('#flash')), await p.innerText('#flash'));
  // el jugador ve el resultado con nombres públicos
  await p.goto(PAGE + '#/fidelidad?rol=support'); await p.reload(); await p.waitForSelector('#lpq', { timeout: 60000 });
  await p.fill('#lpq', pids[0]); await p.dispatchEvent('#lpq', 'change');
  await p.waitForFunction(() => /Ganadores:/.test(document.querySelector('#gamx')?.textContent ?? ''), null, { timeout: 30000 });
  const res = await p.innerText('#gamx');
  ok('J.3', !pids.some((id) => res.includes(id)), 'resultado sin ids de jugadores');
  const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await m.goto(PAGE + '#/concursos?rol=crm_analyst'); await m.waitForSelector('#cnnew', { timeout: 60000 }); await settle(m);
  ok('mob.concursos', (await m.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1, 'sin desborde a 390 px');
  console.log(out.join('\n')); console.log('errores JS:', errs.join(' | ') || 'ninguno'); finish(out, errs);
});

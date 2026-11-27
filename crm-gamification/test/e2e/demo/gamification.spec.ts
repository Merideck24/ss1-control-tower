// Trasladado desde el directorio de trabajo (gamui.cjs) sin cambiar sus comprobaciones.
import { test } from '@playwright/test';
import { AXE, DEMO_URL, finish } from '../lib/env.ts';
const PAGE = DEMO_URL;
const out = []; const ok = (id, c, d = '') => out.push(`${c ? 'OK  ' : 'FAIL'} ${id} ${d}`);
const settle = (p) => p.waitForFunction(() => !/Cargando…/.test(document.querySelector('#view')?.textContent ?? ''), null, { timeout: 60000 });
test('Gamificación: reto en el backoffice, inscripción, progreso en vivo, logro y tarjeta', async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const b = browser; const errs = [];
  const p = await b.newPage({ viewport: { width: 1280, height: 950 } }); p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => d.accept('fin de la prueba'));
  // backoffice: analista crea, aprobador aprueba
  await p.goto(PAGE + '#/retos?rol=crm_analyst'); await p.waitForSelector('#chnew', { timeout: 60000 }); await settle(p);
  const rows = await p.$$eval('#view table tr', (r) => r.length);
  ok('B.1', rows > 3, `tabla de retos con ${rows - 1} filas (demo sembrada)`);
  ok('B.2', /inscritos/i.test(await p.innerText('#view')) && /Cómo se calculan/.test(await p.innerText('#view')), 'métricas y definiciones');
  await p.fill('#chnew [name=name]', 'Reto de prueba UI');
  await p.selectOption('#chnew [name=step1]', '3'); await p.fill('#chnew [name=target1]', '2');
  await p.click('#chnew button[type=submit]'); await p.waitForTimeout(900);
  ok('B.3', /guardado/.test(await p.innerText('#flash')), await p.innerText('#flash'));
  await p.click('[data-cha="submit"][data-cid="reto_reto_de_prueba_ui"]'); await p.waitForTimeout(600);
  ok('B.4', /enviado a aprobación/.test(await p.innerText('#flash')), await p.innerText('#flash'));
  ok('B.5', !(await p.$('[data-cha="approve"]')), 'el analista no ve «Aprobar»');
  await p.click('[data-chsim="reto_primeros_pasos"]'); await p.waitForSelector('[data-chout="reto_primeros_pasos"]:not([hidden]) .simres');
  ok('B.6', /se completa/.test(await p.innerText('[data-chout="reto_primeros_pasos"]')), 'simulación sin efectos');
  await p.click('[data-chimp="reto_diario_explora"]'); await p.waitForSelector('[data-chout="reto_diario_explora"]:not([hidden]) .simres');
  const imp = await p.innerText('[data-chout="reto_diario_explora"]');
  ok('B.6b', /grupo de control 20/.test(imp) && /Expuestos/i.test(imp) && /Retención D7/i.test(imp), 'impacto: control, expuestos y retención');
  await p.addScriptTag({ content: AXE });
  let vs = await p.evaluate(async () => (await axe.run('#view')).violations.map((v) => `${v.id}(${v.nodes.length}) ${v.nodes[0].html.slice(0, 90)}`));
  ok('B.axe', vs.length === 0, vs.join(' | ') || 'sin violaciones');
  await p.goto(PAGE + '#/retos?rol=approver'); await p.reload(); await p.waitForSelector('[data-cha="approve"]', { timeout: 60000 });
  await p.click('[data-cha="approve"][data-cid="reto_reto_de_prueba_ui"]'); await p.waitForTimeout(600);
  ok('B.7', /aprobado/.test(await p.innerText('#flash')), await p.innerText('#flash'));
  // jugador: tenant_admin para poder simular eventos
  await p.goto(PAGE + '#/fidelidad?rol=tenant_admin'); await p.reload(); await p.waitForSelector('#lpq', { timeout: 60000 });
  const pid = await p.evaluate(async () => { const h = { 'x-tenant-id': 'tenant-rumbawin', 'x-roles': 'tenant_admin', 'x-actor': 'qa@ss1' }; const ps = await (await fetch('/api/players?sort=recent', { headers: h })).json(); for (const x of ps) { const cs = await (await fetch(`/api/players/${x.player_id}/challenges`, { headers: h })).json(); const c = cs.find((y) => y.id === 'reto_primeros_pasos'); if (c && !c.enrolled && !c.ineligible.length) return x.player_id; } return null; });
  ok('J.0', !!pid, `jugador elegible no inscrito: ${pid}`);
  await p.fill('#lpq', pid); await p.dispatchEvent('#lpq', 'change'); await p.waitForSelector('#gamx [data-gjoin="reto_primeros_pasos"]', { timeout: 30000 });
  await p.waitForFunction(() => /En vivo/.test(document.querySelector('#rtstate')?.textContent ?? ''), null, { timeout: 15000 });
  ok('J.1', true, 'canal en vivo');
  await p.click('#gamx [data-gjoin="reto_primeros_pasos"]'); await p.waitForSelector('#gamx [data-gleave="reto_primeros_pasos"]', { timeout: 10000 });
  ok('J.2', true, 'inscrito');
  await p.click('#gamx details.tech summary');
  await p.click('[data-gsim="profile_completed"]');
  await p.waitForFunction(() => /✓ Completa tu perfil/.test(document.querySelector('#gamx')?.textContent ?? ''), null, { timeout: 10000 });
  ok('J.3', true, 'el progreso llega solo, por el canal en vivo');
  for (let i = 0; i < 2; i++) { await p.click('#gamx details.tech summary').catch(() => {}); await p.click('[data-gsim="feature_visited"]'); await p.waitForTimeout(2600); }
  for (let i = 0; i < 3; i++) { await p.click('#gamx details.tech summary').catch(() => {}); await p.click('[data-gsim="bet"]'); await p.waitForTimeout(2600); }
  const txt = await p.innerText('#gamx');
  const done = /Completado/.test(txt);
  ok('J.4', done, done ? 'reto completado' : txt.replace(/\s+/g, ' ').slice(0, 300));
  ok('J.5', /Recompensa: Confirmada/.test(txt), 'recompensa confirmada');
  ok('J.6', /Retador[\s\S]{0,40}Bronce/.test(txt), 'logro Retador · Bronce desbloqueado');
  await p.click('[data-gshare="retador"]'); await p.waitForSelector('#gshare .gcard svg');
  ok('J.7', /no muestra saldos/.test(await p.innerText('#gshare')), 'aviso de privacidad de la tarjeta');
  await p.fill('#galiasv', 'QAJugador'); await p.check('#galiasshow'); await p.click('#galias button'); await p.waitForTimeout(700);
  ok('J.8', /QAJugador/.test(await p.innerHTML('#gshare .gcard')), 'alias en la tarjeta');
  await p.click('#gsh'); ok('J.9', await p.isVisible('#gconfirm'), 'pide confirmación antes de crear el enlace');
  await p.addScriptTag({ content: AXE });
  vs = await p.evaluate(async () => (await axe.run('#view')).violations.map((v) => `${v.id}(${v.nodes.length}) ${v.nodes[0].html.slice(0, 90)}`));
  ok('J.axe', vs.length === 0, vs.join(' | ') || 'sin violaciones');
  await p.locator('#gamx').screenshot({ path: testInfo.outputPath('gam-phone.png') });
  const m = await b.newPage({ viewport: { width: 390, height: 844 } });
  await m.goto(PAGE + '#/retos?rol=crm_analyst'); await m.waitForSelector('#chnew', { timeout: 60000 }); await settle(m);
  ok('mob.retos', (await m.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1, 'sin desborde a 390 px');
  console.log(out.join('\n')); console.log('errores JS:', errs.join(' | ') || 'ninguno'); finish(out, errs);
});

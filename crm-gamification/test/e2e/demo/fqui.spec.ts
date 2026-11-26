// Trasladado desde el directorio de trabajo de la Fase 1/2 (fqui.cjs) sin cambiar sus comprobaciones.
// Corre contra la demo publicada (build estático). Ver test/e2e/README.md.
import { test } from '@playwright/test';
import { AXE, DEMO_URL, finish } from '../lib/env.ts';
let OUT = () => '.';

const PAGE = DEMO_URL;
const out = []; const ok = (id, c, d = '') => out.push(`${c ? 'OK  ' : 'FAIL'} ${id} ${d}`);
test('Cola de fallas: filtrar, entender, reprocesar, por rol', async ({ browser }, testInfo) => {
  OUT = () => testInfo.outputDir;
  const b = browser; const errs = [];
  const p = await b.newPage({ viewport: { width: 1280, height: 950 } }); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(PAGE + '#/cola-de-fallas?rol=crm_analyst'); await p.waitForSelector('#fqf', { timeout: 60000 });
  ok('Q.1', /\d+ fallas/.test(await p.innerText('#view')), (await p.innerText('#view h2:nth-of-type(1)')).slice(0, 60));
  await p.selectOption('#fqf [name=status]', 'transitoria'); await p.click('#fqf button[type=submit]'); await p.waitForTimeout(500);
  const n = await p.$$eval('[data-fopen]', (x) => x.length);
  ok('Q.2', n === 2, `filtro «transitoria»: ${n} fallas`);
  await p.click('[data-fopen]'); await p.waitForSelector('#fdetail:not([hidden]) #frp', { timeout: 10000 });
  const det = (await p.innerText('#fdetail')).replace(/\s+/g, ' ');
  ok('Q.3', /no estaba disponible/.test(det) && /clave de idempotencia/i.test(det) && /versión \d/i.test(det), det.slice(0, 160));
  ok('Q.4', await p.$eval('#frpgo', (x) => x.disabled), 'botón deshabilitado sin motivo ni confirmación');
  await p.fill('#frpreason', 'el proveedor ya se recuperó'); await p.check('#frpok');
  ok('Q.5', !(await p.$eval('#frpgo', (x) => x.disabled)), 'habilitado con motivo y confirmación');
  await p.addScriptTag({ content: AXE });
  const vs = await p.evaluate(async () => (await axe.run('#view')).violations.map((v) => `${v.id}(${v.nodes.length}) ${v.nodes[0].html.slice(0, 80)}`));
  ok('Q.axe', vs.length === 0, vs.join(' | ') || 'sin violaciones');
  await p.click('#frpgo'); await p.waitForTimeout(800);
  ok('Q.6', /Aceptado/.test(await p.innerText('#flash')), await p.innerText('#flash'));
  ok('Q.7', /Reprocesos anteriores/.test(await p.innerText('#fdetail')) && /ya no es una falla/.test(await p.innerText('#fdetail')), 'historial y estado resuelto en el detalle');
  await p.screenshot({ path: OUT() + '/fq.png', fullPage: false });
  // auditor: ve sin reprocesar; oficial de JR: no ve la pestaña
  await p.goto(PAGE + '#/cola-de-fallas?rol=auditor'); await p.reload(); await p.waitForSelector('[data-fopen]', { timeout: 60000 });
  await p.click('[data-fopen]'); await p.waitForSelector('#fdetail:not([hidden])');
  ok('Q.8', !(await p.$('#frp')) && /no reprocesarla/.test(await p.innerText('#fdetail')), 'auditor: solo lectura');
  await p.goto(PAGE + '#/control-tower?rol=rg_officer'); await p.reload(); await p.waitForSelector('#tabs [data-k]', { timeout: 60000 }); ok('Q.9a', !!(await p.$('#tabs [data-k="rg"]')), 'el menú del oficial sí carga');
  ok('Q.9', !(await p.$('#tabs [data-k="failures"]')), 'oficial de JR: sin acceso a la cola');
  const m = await b.newPage({ viewport: { width: 390, height: 844 } });
  await m.goto(PAGE + '#/cola-de-fallas?rol=crm_analyst'); await m.waitForSelector('#fqf', { timeout: 60000 });
  ok('Q.mob', (await m.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1, 'sin desborde a 390 px');
  console.log(out.join('\n')); console.log('errores JS:', errs.join(' | ') || 'ninguno'); finish(out, typeof errs === "undefined" ? [] : errs);
});

// Trasladado desde el directorio de trabajo de la Fase 1/2 (closeui.cjs) sin cambiar sus comprobaciones.
// Corre contra la demo publicada (build estático). Ver test/e2e/README.md.
import { test } from '@playwright/test';
import { AXE, DEMO_URL, finish } from '../lib/env.ts';
let OUT = () => '.';
// Constructor: Seguimiento y Cerrar en el navegador, por rol.

const PAGE = DEMO_URL;
const SLUG = process.argv[2] || 'constructor';
const out = []; const ok = (id, c, d = '') => out.push(`${c ? 'OK  ' : 'FAIL'} ${id} ${d}`);
test('Constructor: seguimiento y cierre por rol', async ({ browser }, testInfo) => {
  OUT = () => testInfo.outputDir;
  const b = browser; const errs = [];
  const p = await b.newPage({ viewport: { width: 1280, height: 950 } }); p.on('pageerror', (e) => errs.push(e.message));
  p.on('dialog', (d) => d.accept('fin de la campaña QA'));
  await p.goto(PAGE + `#/${SLUG}?rol=crm_analyst`); await p.waitForSelector('[data-runs]', { timeout: 60000 });
  ok('U.1', (await p.$$('[data-close]')).length === 0, 'analista: sin botón Cerrar');
  await p.click('[data-runs]'); await p.waitForSelector('[data-runsout]:not([hidden]) .simres', { timeout: 10000 });
  const txt = (await p.innerText('[data-runsout]:not([hidden])')).replace(/\s+/g, ' ');
  ok('U.2', /Instancias: \d/.test(txt) && /Supresiones por motivo/.test(txt), txt.slice(0, 240));
  await p.addScriptTag({ content: AXE });
  const vs = await p.evaluate(async () => (await axe.run('#view')).violations.map((v) => `${v.id}(${v.nodes.length})`));
  ok('U.axe', vs.length === 0, vs.join(',') || 'sin violaciones');
  await p.locator('[data-runsout]:not([hidden])').first().screenshot({ path: OUT() + '/runs.png' });
  await p.goto(PAGE + `#/${SLUG}?rol=tenant_admin`); await p.reload(); await p.waitForSelector('[data-close]', { timeout: 60000 });
  const id = await p.$eval('[data-close]', (x) => x.dataset.close);
  await p.click(`[data-close="${id}"]`); await p.waitForTimeout(800);
  ok('U.3', /Recorrido cerrado/.test(await p.innerText('#flash')), await p.innerText('#flash'));
  ok('U.4', !(await p.$(`[data-close="${id}"]`)), `«${id}» ya no se puede cerrar`);
  console.log(out.join('\n')); console.log('errores JS:', errs.join(' | ') || 'ninguno'); finish(out, typeof errs === "undefined" ? [] : errs);
});

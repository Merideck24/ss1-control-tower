// Trasladado desde el directorio de trabajo de la Fase 1/2 (a11y.cjs) sin cambiar sus comprobaciones.
// Corre contra la demo publicada (build estático). Ver test/e2e/README.md.
import { test } from '@playwright/test';
import { AXE, DEMO_URL, finish } from '../lib/env.ts';
let OUT = () => '.';
// Accesibilidad del Constructor y estados de entrega: axe-core + prueba de teclado del lienzo.

const PAGE = DEMO_URL;
const out = []; const ok = (id, c, d = '') => out.push(`${c ? 'OK  ' : 'FAIL'} ${id} ${d}`);
const ready = (p) => p.waitForFunction(() => !/Preparando|Cargando/.test(document.querySelector('#view')?.textContent ?? '') && (document.querySelector('#view')?.textContent ?? '').length > 50, null, { timeout: 60000 });
const axe = async (p, rules) => { await p.addScriptTag({ content: AXE }); return p.evaluate(async (rules) => (await axe.run('#view', { runOnly: { type: 'rule', values: rules } })).violations.map((v) => ({ id: v.id, n: v.nodes.length, sample: v.nodes[0]?.html.slice(0, 120) })), rules); };

test('Tres hallazgos del QA previo: selectores con nombre, sin controles anidados, «Aceptado»', async ({ browser }, testInfo) => {
  OUT = () => testInfo.outputDir;
  const b = browser; const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 } }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(PAGE + '#/builder?rol=crm_analyst'); await ready(p); await p.waitForTimeout(500);

  // 1) selectores con nombre accesible y que identifican el recorrido
  const sels = await p.$$eval('[data-simp]', (ss) => ss.map((s) => s.getAttribute('aria-label')));
  const names = await Promise.all((await p.$$('[data-simp]')).map(async (h) => (await h.evaluate((s) => s.closest('.card').querySelector('h2').textContent))));
  ok('1.a', sels.length >= 8 && sels.every((x, i) => x && x.includes(names[i])), `${sels.length} selectores; ej. «${sels[0]}»`);
  const byRole = await p.getByRole('combobox', { name: `Jugador para simular «${names[0]}»` }).count();
  ok('1.b', byRole === 1, `localizable por rol y nombre: ${byRole}`);

  // axe sobre el Constructor completo
  const v = await axe(p, ['select-name', 'nested-interactive', 'label', 'button-name', 'aria-allowed-attr', 'aria-valid-attr-value', 'duplicate-id']);
  ok('axe', v.length === 0, v.length ? JSON.stringify(v) : 'sin violaciones (select-name, nested-interactive, button-name, label, aria)');

  // 2) lienzo con teclado: seleccionar un paso, conectar una salida a otro paso, cancelar con Escape
  await p.click('#bcanvas'); // asegura que el lienzo exista
  const bodies = await p.$$eval('[data-jsel]', (bs) => bs.map((x) => x.dataset.jsel));
  ok('2.a', bodies.length >= 3, `pasos como botones: ${bodies.join(', ')}`);
  const nested = await p.evaluate(() => [...document.querySelectorAll('#bcanvas button, #bcanvas [role=button]')].filter((x) => x.parentElement.closest('button, [role=button]')).length);
  ok('2.b', nested === 0, `controles anidados: ${nested}`);
  // foco con Tab hasta el primer paso
  await p.focus(`[data-jsel="${bodies[0]}"]`); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  const sel = await p.evaluate(() => ({ focus: document.activeElement?.dataset.jsel, pressed: document.activeElement?.getAttribute('aria-pressed'), insp: document.querySelector('#binspector')?.textContent.slice(0, 60) }));
  ok('2.c', sel.focus === bodies[0] && sel.pressed === 'true', `Enter selecciona y el foco se queda: ${JSON.stringify(sel)}`);
  // Tab desde el paso llega a su salida (hermana, no anidada)
  await p.keyboard.press('Tab');
  const port = await p.evaluate(() => ({ port: document.activeElement?.dataset.port, key: document.activeElement?.dataset.key, name: document.activeElement?.getAttribute('aria-label') }));
  ok('2.d', port.port === bodies[0], `Tab → ${JSON.stringify(port)}`);
  // Espacio activa la salida; el foco sigue en ella y marca aria-pressed
  await p.keyboard.press(' '); await p.waitForTimeout(300);
  const armed = await p.evaluate(() => ({ port: document.activeElement?.dataset.port, pressed: document.activeElement?.getAttribute('aria-pressed'), targets: document.querySelectorAll('.jnode.target').length }));
  ok('2.e', armed.port === bodies[0] && armed.pressed === 'true' && armed.targets > 0, `Espacio en la salida: ${JSON.stringify(armed)}`);
  // Escape cancela y devuelve el foco a la salida
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  const cancel = await p.evaluate(() => ({ targets: document.querySelectorAll('.jnode.target').length, focus: document.activeElement?.dataset.port }));
  ok('2.f', cancel.targets === 0 && cancel.focus === bodies[0], `Escape: ${JSON.stringify(cancel)}`);
  // conectar con teclado: salida del primero → cuerpo del último
  const before = await p.evaluate(() => JSON.parse(document.querySelector('#bjson').value));
  const src = before.nodes.find((n) => n.id === bodies[0]); const dst = bodies[bodies.length - 1];
  await p.focus(`[data-port="${bodies[0]}"]`); await p.keyboard.press('Enter'); await p.waitForTimeout(250);
  await p.focus(`[data-jsel="${dst}"]`); await p.keyboard.press('Enter'); await p.waitForTimeout(400);
  const after = await p.evaluate(() => JSON.parse(document.querySelector('#bjson').value));
  const key = (await p.$eval(`[data-port="${bodies[0]}"]`, (x) => x.dataset.key));
  const val = key.startsWith('v:') ? after.nodes.find((n) => n.id === bodies[0]).variants[Number(key.slice(2))].next : after.nodes.find((n) => n.id === bodies[0])[key];
  ok('2.g', val === dst && (await p.evaluate(() => document.activeElement?.dataset.jsel)) === dst, `conexión ${bodies[0]}.${key} → ${val} (antes ${src[key] ?? '—'}); foco en destino`);
  // el ratón sigue funcionando: arrastrar un paso no lo selecciona por error ni rompe el clic
  const box = await p.$eval(`[data-jn="${bodies[1]}"]`, (x) => { const r = x.getBoundingClientRect(); return { x: r.x + 60, y: r.y + 30 }; });
  await p.mouse.move(box.x, box.y); await p.mouse.down(); await p.mouse.move(box.x + 80, box.y + 40, { steps: 6 }); await p.mouse.up(); await p.waitForTimeout(300);
  const moved = await p.evaluate((id) => JSON.parse(document.querySelector('#bjson').value).layout[id], bodies[1]);
  ok('2.h', moved && typeof moved.x === 'number', `arrastre guarda posición ${JSON.stringify(moved)}`);
  await p.click(`[data-jsel="${bodies[1]}"]`); await p.waitForTimeout(300);
  ok('2.i', (await p.$eval(`[data-jsel="${bodies[1]}"]`, (x) => x.getAttribute('aria-pressed'))) === 'true', 'clic selecciona el paso');
  await p.screenshot({ path: OUT() + '/a11y-canvas.png', clip: await p.$eval('#bcanvas', (x) => { const r = x.getBoundingClientRect(); return { x: r.x, y: r.y, width: Math.min(r.width, 900), height: Math.min(r.height, 420) }; }) });

  // 3) estados de entrega alineados
  await p.selectOption('#role', 'tenant_admin'); await ready(p);
  await p.click('nav button:has-text("Control Tower")'); await p.waitForTimeout(600);
  const ct = await p.innerText('#view');
  ok('3.a', /Envíos aceptados/i.test(ct) && !/Entregas aceptadas/i.test(ct), 'total: «Envíos aceptados»');
  ok('3.b', /· Aceptado/.test(ct) && !/· Entregado/.test(ct), `desglose: ${(ct.match(/[A-Za-z-]+ · Aceptado[^A-Z]{0,12}/) ?? ['?'])[0].trim()}`);
  await p.click('nav button:has-text("Analítica")'); await p.waitForTimeout(800);
  const an = await p.innerText('#view');
  ok('3.c', /ACEPTADOS|Aceptados/.test(an) && !/\bEntregados\b/i.test(an.split('Canales de entrega')[1]?.split('\n').slice(0, 3).join(' ') ?? ''), 'Analítica: columna «Aceptados»');
  const v2 = await axe(p, ['select-name', 'nested-interactive', 'button-name']);
  ok('axe-an', v2.length === 0, v2.length ? JSON.stringify(v2) : 'Analítica sin violaciones');

  console.log(out.join('\n')); console.log('errores JS:', errs.length ? errs.join(' | ') : 'ninguno');
  finish(out, typeof errs === "undefined" ? [] : errs);
});

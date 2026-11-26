// Trasladado desde el directorio de trabajo de la Fase 1/2 (formtest.cjs) sin cambiar sus comprobaciones.
// Corre contra la demo publicada (build estático). Ver test/e2e/README.md.
import { test } from '@playwright/test';
import { AXE, DEMO_URL, finish } from '../lib/env.ts';
let OUT = () => '.';
// Formularios: Segmentos (constructor de reglas), Nueva misión y Copiloto, de punta a punta en el navegador.

const PAGE = DEMO_URL;
const out = []; const ok = (id, c, d = '') => out.push(`${c ? 'OK  ' : 'FAIL'} ${id} ${d}`);
const json = (p, sel) => p.$eval(sel, (t) => JSON.parse(t.value || 'null'));

test('Formularios: segmentos, misión y copiloto', async ({ browser }, testInfo) => {
  OUT = () => testInfo.outputDir;
  const b = browser; const errs = [];
  const p = await b.newPage({ viewport: { width: 1280, height: 950 } });
  p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => d.accept());

  // ---------- Segmentos ----------
  await p.goto(PAGE + '#/segmentos?rol=crm_analyst');
  await p.waitForSelector('#rbRules .rbrow', { timeout: 60000 });
  const rows0 = await p.$$eval('#rbRules .rbrow', (r) => r.length);
  ok('S.1', rows0 === 2 && (await p.$eval('#rbRules [data-rbmode]', (s) => s.value)) === 'and', `regla de ejemplo cargada en el formulario: ${rows0} condiciones, «todas»`);
  ok('S.2', (await p.$$eval('#rbExcl .rbrow', (r) => r.length)) === 1, 'exclusión de ejemplo cargada');
  // agregar condición: depósitos acumulados al menos 500.000 COP
  await p.click('#rbRules [data-rbadd]');
  await p.selectOption('#rbRules [data-rbf="2"]', 'stats.deposits_minor');
  await p.fill('#rbRules [data-rbv="2"]', '500000');
  await p.dispatchEvent('#rbRules [data-rbv="2"]', 'change');
  const r1 = await json(p, '#rules');
  ok('S.3', r1.and?.length === 3 && r1.and[2].field === 'stats.deposits_minor' && r1.and[2].value === 50_000_000 && r1.and[2].op === 'gte', `JSON sincronizado: ${JSON.stringify(r1.and[2])}`);
  await p.selectOption('#rbRules [data-rbmode]', 'or');
  ok('S.4', Array.isArray((await json(p, '#rules')).or), '«alguna» → OR');
  await p.selectOption('#rbRules [data-rbmode]', 'and');
  await p.click('#prev'); await p.waitForSelector('#segout .kpi', { timeout: 10000 });
  const size = await p.$eval('#segout', (x) => x.innerText.match(/Tamaño\s*([\d.]+)/)?.[1]);
  ok('S.5', size !== undefined, `vista previa con el formulario: tamaño ${size}`);
  // quitar condición y JSON inválido aplicado
  await p.click('#rbRules [data-rbdel="2"]');
  ok('S.6', (await json(p, '#rules')).and.length === 2, 'quitar condición');
  await p.click('details.tech summary'); await p.fill('#rules', '{"or":[{"field":"kyc","op":"eq","value":"pending"},{"field":"rg","op":"eq","value":"self_excluded"}]}');
  await p.click('#rbapply'); await p.waitForTimeout(200);
  ok('S.7', (await p.$eval('#rbRules [data-rbmode]', (s) => s.value)) === 'or' && (await p.$$eval('#rbRules .rbrow', (r) => r.length)) === 2, 'JSON → formulario');
  await p.fill('#rules', '{"and": [ {"not": {"field":"kyc","op":"eq","value":"pending"}} ]}'); await p.click('#rbapply'); await p.waitForTimeout(200);
  ok('S.8', /no cabe en el formulario/.test(await p.innerText('#rbRules')), 'regla avanzada (NOT): aviso, se edita como JSON');
  await p.fill('#rules', '{mal json'); await p.click('#rbapply'); await p.waitForTimeout(200);
  ok('S.9', /no es válido/.test(await p.innerText('#flash')), 'JSON inválido: aviso claro');
  // botón «Usar» de la tabla de ciclo de vida
  await p.goto(PAGE + '#/segmentos?rol=crm_analyst'); await p.waitForSelector('#rbRules .rbrow');
  await p.click('[data-use]'); await p.waitForTimeout(500);
  const used = await p.$$eval('#rbRules .rbrow', (r) => r.map((x) => [...x.querySelectorAll('select')].map((s) => s.selectedOptions[0]?.textContent).join(' ')));
  ok('S.10', used.length === 1 && /Etapa del ciclo de vida es/.test(used[0]), `«Usar» carga en el formulario: ${used[0]}`);
  await p.addScriptTag({ content: AXE });
  const vs = await p.evaluate(async () => (await axe.run('#view')).violations.map((v) => `${v.id}(${v.nodes.length})`));
  ok('S.axe', vs.length === 0, vs.join(', ') || 'sin violaciones');

  // ---------- Nueva misión ----------
  await p.goto(PAGE + '#/gamificacion?rol=crm_analyst'); await p.waitForSelector('#mform', { timeout: 60000 });
  await p.fill('#mform [name=name]', 'Depósitos de fin de mes');
  ok('M.1', (await p.inputValue('#mform [name=id]')) === 'm_depositos_de_fin_de_mes', `id propuesto desde el nombre: ${await p.inputValue('#mform [name=id]')}`);
  await p.selectOption('#mform [name=event_type]', 'deposit.settled');
  ok('M.2', await p.$eval('#mform [name=product]', (s) => s.disabled), 'producto deshabilitado para depósitos');
  await p.selectOption('#mform [name=kind]', 'sum'); await p.fill('#mform [name=target]', '300000');
  ok('M.3', (await p.textContent('#munit')) === 'COP' && (await json(p, '#mdraft')).target === 30_000_000, 'meta en COP → unidades mínimas en el JSON');
  await p.fill('#mform [name=xp]', '250'); await p.fill('#mform [name=description]', 'Deposita 300.000 en el mes');
  await p.fill('#mform [name=ends_at]', '2020-01-01'); await p.dispatchEvent('#mform [name=ends_at]', 'change');
  ok('M.4', /posterior a «Desde»/.test(await p.innerText('#merr')), 'fechas inválidas: aviso');
  await p.click('#msave'); await p.waitForTimeout(300);
  ok('M.5', !/guardado/.test(await p.innerText('#flash')), 'no guarda con errores');
  const end = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
  await p.fill('#mform [name=ends_at]', end); await p.dispatchEvent('#mform [name=ends_at]', 'change');
  await p.click('#msave'); await p.waitForTimeout(800);
  ok('M.6', /Borrador «Depósitos de fin de mes» guardado/.test(await p.innerText('#flash')) && /Depósitos de fin de mes/.test(await p.innerText('#view')), `guardado: ${await p.innerText('#flash')}`);
  if (await p.$('#mform [name=reward_kind] option[value=item]')) { await p.selectOption('#mform [name=reward_kind]', 'item'); ok('M.7', (await json(p, '#mdraft')).reward.reward_id && !(await p.isVisible('#mxp')), `recompensa del catálogo: ${(await json(p, '#mdraft')).reward.reward_id}`); }
  await p.addScriptTag({ content: AXE });
  const vm = await p.evaluate(async () => (await axe.run('#mform')).violations.map((v) => `${v.id}(${v.nodes.length})`));
  ok('M.axe', vm.length === 0, vm.join(', ') || 'sin violaciones');

  // ---------- Copiloto ----------
  await p.goto(PAGE + '#/copiloto?rol=crm_analyst'); await p.waitForSelector('#tform select, #tform input', { timeout: 60000 });
  const toolNames = await p.$$eval('#tool option', (o) => o.map((x) => x.textContent));
  ok('C.1', toolNames.every((t) => !/_/.test(t)), `herramientas con nombre legible: ${toolNames.join(' · ')}`);
  await p.selectOption('#tform [data-tp="metric"]', 'kyc_verified_rate'); await p.dispatchEvent('#tform [data-tp="metric"]', 'change');
  await p.click('#call'); await p.waitForFunction(() => document.querySelector('#cres :is(table, .kpi, .bad)') && !/Ejecutando/.test(document.querySelector('#cres').textContent), null, { timeout: 10000 });
  ok('C.2', !/No se pudo/.test(await p.innerText('#cres')), `métrica: ${(await p.innerText('#cres')).replace(/\s+/g, ' ').slice(0, 100)}`);
  await p.selectOption('#tool', 'preview_segment'); await p.waitForSelector('#tform .rb', { timeout: 5000 });
  ok('C.3', (await p.$$eval('#tform .rb', (x) => x.length)) === 2, 'vista previa de segmento: reglas y exclusiones con el constructor');
  await p.click('#call'); await p.waitForFunction(() => document.querySelector('#cres :is(table, .kpi, .bad)') && !/Ejecutando/.test(document.querySelector('#cres').textContent), null, { timeout: 10000 });
  ok('C.4', !/No se pudo/.test(await p.innerText('#cres')), `segmento: ${(await p.innerText('#cres')).replace(/\s+/g, ' ').slice(0, 100)}`);
  await p.selectOption('#tool', 'simulate_journey'); await p.waitForSelector('#tform [data-tk="journey"]', { timeout: 5000 });
  await p.selectOption('#tform [data-tp="synthetic_profile.rg"]', 'self_excluded'); await p.dispatchEvent('#tform [data-tp="synthetic_profile.rg"]', 'change');
  const tin = await json(p, '#tin');
  ok('C.5', tin.journey?.id && tin.synthetic_profile?.rg === 'self_excluded', `simular: recorrido «${tin.journey?.id}» y perfil sintético desde el formulario`);
  await p.click('#call'); await p.waitForFunction(() => document.querySelector('#cres :is(table, .kpi, .bad)') && !/Ejecutando/.test(document.querySelector('#cres').textContent), null, { timeout: 10000 });
  ok('C.6', !/No se pudo/.test(await p.innerText('#cres')), `simulación: ${(await p.innerText('#cres')).replace(/\s+/g, ' ').slice(0, 110)}`);
  await p.addScriptTag({ content: AXE });
  const vc = await p.evaluate(async () => (await axe.run('#view')).violations.map((v) => `${v.id}(${v.nodes.length})`));
  ok('C.axe', vc.length === 0, vc.join(', ') || 'sin violaciones');
  await p.screenshot({ path: OUT() + '/form-copilot.png', fullPage: false });

  // ---------- móvil ----------
  const m = await b.newPage({ viewport: { width: 390, height: 844 } });
  for (const [k, sel] of [['segmentos', '#rbRules .rbrow'], ['gamificacion', '#mform'], ['copiloto', '#tform select']]) {
    await m.goto(PAGE + `#/${k}?rol=crm_analyst`); await m.waitForSelector(sel, { timeout: 60000 }); await m.waitForTimeout(300);
    const over = await m.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok(`mob.${k}`, over <= 1, `desborde a 390 px: ${over}`);
    if (k === 'segmentos') await m.screenshot({ path: OUT() + '/form-seg-mobile.png', fullPage: false, clip: { x: 0, y: 0, width: 390, height: 844 } });
  }
  console.log(out.join('\n')); console.log('errores JS:', errs.length ? errs.join(' | ') : 'ninguno');
  finish(out, typeof errs === "undefined" ? [] : errs);
});

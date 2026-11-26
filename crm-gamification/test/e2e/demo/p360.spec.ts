// Trasladado desde el directorio de trabajo de la Fase 1/2 (p360.cjs) sin cambiar sus comprobaciones.
// Corre contra la demo publicada (build estático). Ver test/e2e/README.md.
import { test } from '@playwright/test';
import { AXE, DEMO_URL, finish } from '../lib/env.ts';
let OUT = () => '.';
const PAGE = DEMO_URL;
const out = []; const ok = (id, c, d = '') => out.push(`${c ? 'OK  ' : 'FAIL'} ${id} ${d}`);
const ready = (p) => p.waitForFunction(() => document.querySelector('#plist table, #plist .notfound'), null, { timeout: 60000 });
test('Perfil 360: maestro-detalle, búsqueda, filtros, páginas', async ({ browser }, testInfo) => {
  OUT = () => testInfo.outputDir;
  const b = browser; const errs = [];
  for (const [w, h] of [[463, 900], [1400, 950]]) {
    const p = await b.newPage({ viewport: { width: w, height: h } }); p.on('pageerror', (e) => errs.push(`${w}: ${e.message}`));
    await p.goto(PAGE + '#/profile?rol=tenant_admin'); await ready(p);
    const heads = await p.$$eval('#plist thead th', (t) => t.map((x) => x.textContent));
    const rows = await p.$$eval('#plist tbody tr', (r) => r.length);
    ok(`${w}.3`, heads.join('|') === 'Jugador|KYC|Juego responsable|Nivel' && rows === 25, `encabezados ${heads.join(', ')} · ${rows} filas · ${await p.textContent('#pcount')}`);
    await p.fill('#pq', 'google'); await p.waitForTimeout(200);
    const g = await p.$$eval('#plist tbody a', (a) => a.map((x) => x.textContent));
    ok(`${w}.2a`, g.length > 0 && g.every((x) => x.includes('google')), `«google» → ${await p.textContent('#pcount')}`);
    await p.fill('#pq', 'zzz-nadie'); await p.waitForTimeout(200);
    const empty = await p.$eval('#plist', (x) => ({ t: x.innerText, top: x.getBoundingClientRect().top }));
    ok(`${w}.2b`, /Ningún jugador coincide con «zzz-nadie»/.test(empty.t) && empty.top < h, `vacío junto a la búsqueda (y=${Math.round(empty.top)})`);
    await p.fill('#pq', ''); await p.selectOption('#prg', 'self_excluded'); await p.waitForTimeout(200);
    const rg = await p.$$eval('#plist tbody tr td:nth-child(3)', (t) => [...new Set(t.map((x) => x.textContent))]);
    ok(`${w}.3f`, rg.length === 1 && rg[0] === 'Autoexcluido', `filtro JR → ${rg.join(',')} · ${await p.textContent('#pcount')}`);
    await p.selectOption('#prg', ''); await p.waitForTimeout(150);
    if (await p.$('#pnext')) { await p.click('#pnext'); await p.waitForTimeout(150); ok(`${w}.3p`, /Página 2 de/.test(await p.innerText('#plist')), 'paginación'); }
    // abrir un perfil: visible y con foco
    const first = await p.$eval('#plist tbody a', (a) => a.dataset.p);
    await p.click(`[data-p="${first}"]`); await p.waitForFunction((id) => document.querySelector('#pdetail-h')?.textContent.includes(id), first, { timeout: 10000 });
    const vis = await p.$eval('#pdetail-h', (x) => { const r = x.getBoundingClientRect(); return { top: Math.round(r.top), visible: r.top >= 0 && r.bottom <= innerHeight, focus: document.activeElement === x }; });
    ok(`${w}.1`, vis.visible && vis.focus, `perfil visible y con foco ${JSON.stringify(vis)}`);
    ok(`${w}.url`, p.url().includes(`jugador=${first}`), 'ruta por jugador');
    if (w < 700) {
      const cut = await p.$$eval('.psheet td .pv', (v) => v.filter((x) => x.scrollWidth > x.clientWidth + 1).length);
      const rowH = await p.$$eval('.psheet tr', (r) => Math.max(...r.map((x) => x.getBoundingClientRect().height)));
      ok(`${w}.4`, cut === 0, `valores sin recortar; fila más alta ${Math.round(rowH)} px`);
      await p.screenshot({ path: `${OUT()}/p360-mobile-detail.png` });
      await p.keyboard.press('Escape'); await p.waitForTimeout(200);
      ok(`${w}.esc`, !(await p.evaluate(() => document.body.classList.contains('pdetail-open'))) && (await p.evaluate(() => document.activeElement?.dataset.p)) === first, 'Escape vuelve a la lista y al jugador');
    } else await p.screenshot({ path: `${OUT()}/p360-desktop.png` });
    // atrás del navegador vuelve a la lista sin jugador
    await p.goBack(); await p.waitForTimeout(500);
    ok(`${w}.back`, !p.url().includes('jugador='), `atrás → ${p.url().split('#')[1]}`);
    // búsqueda de id exacto inexistente con Enter
    await p.fill('#pq', 'no-existe-1'); await p.press('#pq', 'Enter'); await p.waitForTimeout(500);
    const nf = await p.$eval('#pdetail', (x) => ({ t: x.innerText, top: x.getBoundingClientRect().top }));
    ok(`${w}.nf`, /No encontramos al jugador «no-existe-1»/.test(nf.t) && nf.top < h, `aviso visible (y=${Math.round(nf.top)})`);
    await p.close();
  }
  console.log(out.join('\n')); console.log('errores:', errs.length ? errs.join(' | ') : 'ninguno');
  finish(out, typeof errs === "undefined" ? [] : errs);
});

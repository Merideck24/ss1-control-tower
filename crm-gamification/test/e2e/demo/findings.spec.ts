// Trasladado desde el directorio de trabajo de la Fase 1/2 (findings.cjs) sin cambiar sus comprobaciones.
// Corre contra la demo publicada (build estático). Ver test/e2e/README.md.
import { test } from '@playwright/test';
import { AXE, DEMO_URL, finish } from '../lib/env.ts';
let OUT = () => '.';
// Verifica en navegador los 16 hallazgos de UX sobre la demo estática (dist/index.html).
const pickLp = async (p, id) => { await p.fill('#lpq', id); await p.press('#lpq', 'Enter'); await p.waitForFunction((id) => document.querySelector('#lp')?.value === id, id).catch(() => {}); };

const SP = '/tmp/claude-0/-home-user-ss1-control-tower/b69454b8-d317-5a7c-86f5-77a8506f442b/scratchpad';
const PAGE = DEMO_URL;
const out = [];
const ok = (id, cond, detail = '') => out.push(`${cond ? 'OK  ' : 'FAIL'} ${id} ${detail}`);

// patrones que no deben verse en ninguna pantalla
const BAD = [
  [/\{\{|\bel % del\b|nivel \./, 'variables vacías'],
  [/\b\d+\.\d+\s?(%|XP|pp|ms)\b/, 'decimal con punto'],
  [/\(s\)/, 'plural «(s)»'],
  [/\bfree_spins\b|\bwelcome_fs_10\b|\bmarketing_consent_revoked\b|\bself_excluded\b|\bpending_approval\b/, 'clave interna'],
  [/\b(published|verified|completed|suppressed|accepted)\b/, 'estado en inglés'],
  [/\d{4}-\d{2}-\d{2}/, 'fecha ISO cruda'],
  [/\d\s?K\b/, '«K» mayúscula'],
];
const scan = (where, text) => { for (const [re, name] of BAD) { const m = text.match(re); if (m) out.push(`WARN ${where}: ${name} → «${text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')}»`); } };

test('Hallazgos de UX de la Fase 1 (16 + revisión externa)', async ({ browser }, testInfo) => {
  OUT = () => testInfo.outputDir;
  const b = browser;
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  p.on('dialog', (d) => d.accept());
  await p.goto(PAGE); await p.waitForTimeout(1200);
  const go = async (t) => { await p.click(`nav button:has-text("${t}")`); await p.waitForTimeout(400); };

  // barrido de todas las pestañas con varios roles
  for (const role of ['tenant_admin', 'crm_analyst', 'approver', 'rg_officer']) {
    await p.selectOption('#role', role); await p.waitForTimeout(500);
    for (const t of await p.$$eval('nav button', (bs) => bs.map((x) => x.textContent.trim()))) {
      await go(t); const v = await p.innerText('#view');
      if (/Error:/.test(v)) errs.push(`${role}/${t}: ${v.slice(0, 140)}`);
      if (!/Copiloto|Auditoría|Plantillas|Integraciones/.test(t)) scan(`${role}/${t}`, v);
    }
  }
  await p.selectOption('#role', 'tenant_admin'); await p.waitForTimeout(500);

  // #3
  await go('Analítica');
  const tvc = await p.$$eval('h2', (hs) => { const h = hs.find((x) => /Tratamiento vs\. control/.test(x.textContent)); return [...h.closest('.card').querySelectorAll('tr')].map((r) => r.innerText.replace(/\s+/g, ' ')); });
  const j4 = tvc.find((r) => /j4_loyalty_halfway/.test(r)) ?? '';
  ok('#3', j4 && /—\s*sin grupo de control/.test(j4) && !/pp/.test(j4), j4.slice(0, 160));
  // #11, #12, #15
  const an = await p.innerText('#view');
  ok('#12', /Costo por FTD \(\d+ d\)/i.test(an), 'columna con ventana en calidad de fuentes');
  const inbox = an.match(/Bandeja in-app: ([\d.]+) mensajes en la bandeja, ([\d.]+) abiertos/);
  ok('#15', inbox && Number(inbox[2].replace(/\./g, '')) > 0, inbox ? inbox[0] : 'sin nota');
  await go('Control Tower');
  const ct = await p.innerText('#view');
  ok('#12', /Costo por FTD · \d+ d|últimos 30 días \(sin contar/.test(ct), 'ventana explícita en Control Tower');
  const spend = ct.match(/Último reporte del [^)]*\)/);
  ok('#5', !spend || /hace \d+ días?\)/.test(spend[0]), spend ? spend[0] : 'sin alerta de inversión en la demo');

  // #13
  await go('Gamificación');
  const pred = (await p.innerText('#view')).match(/¿Quién gana la final del [^?]+\?[^\n]*\n?[^\n]*/);
  ok('#13', pred && /domingo/.test(pred[0]), pred ? pred[0].replace(/\s+/g, ' ').slice(0, 140) : 'no hay predicción');

  // #14
  await p.selectOption('#role', 'crm_analyst'); await p.waitForTimeout(500); await go('Aprobación');
  const ap = await p.innerText('#view');
  ok('#14', !/Cambia a «Analista CRM»/.test(ap), (ap.match(/Sin solicitudes[^.]*\./) ?? [''])[0]);
  await p.selectOption('#role', 'tenant_admin'); await p.waitForTimeout(500);

  // #6
  await go('Perfil 360');
  await p.click('[data-p]'); await p.waitForTimeout(400);
  const first = (await p.innerText('#pdetail')).split('\n')[0];
  await p.fill('#pq', 'no-existe-123'); await p.press('#pq', 'Enter'); await p.waitForTimeout(600);
  const nf = await p.innerText('#pdetail');
  ok('#6', /No encontramos al jugador «no-existe-123»/.test(nf) && !nf.includes(first), nf.split('\n')[0]);
  ok('#10', !/\b(verified|self_excluded)\b/.test(await p.innerText('#view')), 'lista de jugadores en español');

  // #1, #4, #9 — fidelidad (móvil)
  await go('Fidelidad (móvil)'); await p.waitForTimeout(600);
  const players = await p.$$eval('#lp option', (os) => os.map((o) => o.value));
  let phone = '';
  for (const id of players.slice(0, 25)) { await pickLp(p, id); await p.waitForTimeout(250); phone += await p.innerText('#lout'); }
  ok('#1', !/el % del|nivel \.|\{\{/.test(phone), 'bandejas de 25 jugadores sin variables vacías');
  ok('#9', !/free_spins|\d{4}-\d{2}-\d{2}|tirada\(s\)|\.00 COP/.test(phone), (phone.match(/Giros gratis[^\n]{0,60}/) ?? ['sin recompensa visible'])[0]);
  scan('fidelidad', phone);
  // girar la ruleta con un jugador que tenga tiradas
  let spun = false;
  for (const id of players) {
    await pickLp(p, id); await p.waitForTimeout(250);
    const btn = await p.$('[data-spin]'); if (!btn) continue;
    await btn.click(); await p.waitForTimeout(600);
    const res = await p.$('.spin-result'); spun = true;
    const txt = res ? (await res.innerText()).replace(/\s+/g, ' ') : '';
    ok('#4', !!res && /(Ganaste|no hubo premio|Salió)/.test(txt), txt.slice(0, 140));
    await p.screenshot({ path: `${SP}/f4-spin.png`, fullPage: false });
    break;
  }
  if (!spun) ok('#4', false, 'ningún jugador con tiradas');

  // #16 menú accesible
  const nav = await p.$$eval('nav#tabs button', (bs) => bs.map((x) => ({ name: x.getAttribute('aria-label'), cur: x.getAttribute('aria-current') })));
  ok('#16', nav.every((x) => x.name) && nav.filter((x) => x.cur === 'page').length === 1, `${nav.length} botones con nombre; seleccionado: ${nav.find((x) => x.cur)?.name}`);
  const snap = await p.accessibility?.snapshot?.().catch(() => null);
  if (snap) { const names = JSON.stringify(snap); ok('#16', names.includes('Secciones del CRM'), 'nav con nombre accesible'); }

  // #7 URL por pantalla, atrás y recarga
  await go('Analítica'); await go('Gamificación');
  ok('#7', /#\/gamificacion\?rol=tenant_admin/.test(p.url()), p.url().split('#')[1]);
  await p.goBack(); await p.waitForTimeout(600);
  ok('#7', (await p.textContent('#pageTitle')) === 'Analítica', `atrás → ${await p.textContent('#pageTitle')}`);
  // borrador + envío a aprobación, luego recarga
  await p.selectOption('#role', 'crm_analyst'); await p.waitForTimeout(500); await go('Constructor');
  await p.fill('#bid', 'j_recarga'); await p.fill('#bname', 'Prueba de recarga'); await p.dispatchEvent('#bname', 'input'); await p.waitForTimeout(400);
  await p.click('#savedraft'); await p.waitForTimeout(400); await p.click('#submit'); await p.waitForTimeout(500);
  await go('Aprobación');
  await p.reload(); await p.waitForTimeout(1500);
  const after = await p.innerText('#view');
  ok('#7', (await p.textContent('#pageTitle')) === 'Aprobación' && (await p.inputValue('#role')) === 'crm_analyst', `tras recargar: ${await p.textContent('#pageTitle')} · rol ${await p.inputValue('#role')}`);
  ok('#7', /Prueba de recarga/.test(after), 'el borrador enviado sigue en Aprobación tras recargar');
  await p.screenshot({ path: `${SP}/f7-reload.png` });

  // #8 cabecera en pantalla angosta
  const m = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await m.goto(PAGE + '#/analytics?rol=tenant_admin'); await m.waitForTimeout(1500);
  const hh = await m.$eval('header.topbar', (h) => h.getBoundingClientRect().height);
  ok('#8', hh / 844 < 0.1, `cabecera ${Math.round(hh)} px = ${(100 * hh / 844).toFixed(1)} % del alto`);
  await m.click('#ctxBtn'); await m.waitForTimeout(200);
  ok('#8', await m.isVisible('#role'), 'el contexto (rol, tenant, marca) se abre a pedido');
  await m.screenshot({ path: `${SP}/f8-mobile-ctx.png` });
  await m.click('#ctxBtn'); await m.mouse.wheel(0, 1500); await m.waitForTimeout(300);
  await m.screenshot({ path: `${SP}/f8-mobile-scrolled.png` });
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok('#8', !overflow, 'sin scroll horizontal a 390 px');

  // limpiar el diario de la demo para no dejar estado
  await p.evaluate(() => localStorage.clear());
  console.log(out.join('\n'));
  console.log('errores JS:', errs.length ? errs.slice(0, 8).join('\n  ') : 'ninguno');
  finish(out, typeof errs === "undefined" ? [] : errs);
});

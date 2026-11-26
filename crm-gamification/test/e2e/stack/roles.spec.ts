/** Navegación por rol, cambio de tenant, accesibilidad y móvil contra web + worker + PostgreSQL. */
import { expect, test } from '@playwright/test';
import { axe } from '../lib/env.ts';
import { main, open } from './_main.ts';

const TABS: Record<string, { must: string[]; never: string[] }> = {
  crm_analyst: { must: ['tower', 'profile', 'segments', 'builder', 'failures', 'analytics'], never: ['audit', 'rg'] },
  approver: { must: ['approval', 'failures', 'analytics', 'audit'], never: ['rg'] },
  support: { must: ['profile', 'failures'], never: ['segments', 'analytics', 'audit'] },
  rg_officer: { must: ['rg', 'profile'], never: ['failures', 'segments', 'analytics'] },
  auditor: { must: ['audit', 'failures', 'analytics'], never: ['segments'] },
  tenant_admin: { must: ['failures', 'integrations', 'policies'], never: [] },
};

for (const [role, t] of Object.entries(TABS)) {
  test(`Navegación por rol: ${role} ve lo suyo y nada más`, async ({ page }) => {
    const { base } = main();
    const errs: string[] = []; page.on('pageerror', (e) => errs.push(e.message));
    await open(page, base, 'control-tower', role);
    const tabs = await page.$$eval('#tabs [data-k]', (xs) => xs.map((x) => (x as HTMLElement).dataset.k!));
    for (const k of t.must) expect(tabs, `${role} debe ver ${k}`).toContain(k);
    for (const k of t.never) expect(tabs, `${role} no debe ver ${k}`).not.toContain(k);
    // cada pestaña visible abre sin error
    for (const k of tabs) {
      await page.click(`#tabs [data-k="${k}"]`);
      await page.waitForFunction(() => !/Cargando…/.test(document.querySelector('#view')?.textContent ?? ''), null, { timeout: 60_000 });
      await expect(page.locator('#view .card.bad'), `${role}/${k} sin error`).toHaveCount(0);
    }
    expect(errs).toEqual([]);
  });
}

test('Accesibilidad: las pantallas principales no tienen violaciones de axe', async ({ page }) => {
  const { base } = main();
  for (const slug of ['control-tower', 'perfil-360', 'segmentos', 'constructor', 'aprobacion', 'cola-de-fallas', 'analitica']) {
    await open(page, base, slug, 'tenant_admin');
    expect(await axe(page), slug).toEqual([]);
  }
});

test('Móvil (390 px): sin desplazamiento horizontal en las pantallas operativas', async ({ browser }) => {
  const { base } = main();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  for (const slug of ['control-tower', 'perfil-360', 'constructor', 'cola-de-fallas']) {
    await open(page, base, slug, 'crm_analyst');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), slug).toBeLessThanOrEqual(1);
  }
  await page.close();
});

test('Cambio de tenant: cada tenant ve solo sus jugadores y su cola', async ({ page }) => {
  const { base } = main();
  await open(page, base, 'perfil-360', 'crm_analyst');
  const first = (await page.textContent('#plist tbody tr td, #plist tr td'))?.trim();
  expect(first).toBeTruthy();
  await page.selectOption('#tenant', 'tenant-demo-b');
  await page.waitForFunction(() => !/Cargando…/.test(document.querySelector('#view')?.textContent ?? ''));
  await page.waitForTimeout(500);
  expect(page.url()).toContain('tenant=tenant-demo-b');
  const r = await page.evaluate(async (id) => (await fetch(`/api/players/${id}`, { headers: { 'x-tenant-id': 'tenant-demo-b', 'x-roles': 'crm_analyst', 'x-actor': 'e2e@ss1' } })).status, first);
  expect(r, 'un jugador de RumbaWin no existe en el otro tenant').toBe(404);
  const qa = await page.evaluate(async () => (await (await fetch('/api/failures', { headers: { 'x-tenant-id': 'tenant-demo-b', 'x-roles': 'crm_analyst', 'x-actor': 'e2e@ss1' } })).json()).items.every((x: { tenant_id: string }) => x.tenant_id === 'tenant-demo-b'));
  expect(qa).toBe(true);
});

/**
 * El guion de usabilidad (docs/usabilidad/GUION.md) tiene solución en la demo con fecha fija: cada
 * tarea T1–T9 se puede completar con los datos indicados. NO mide comprensión: no reemplaza las
 * sesiones con operadores.
 */
import { expect, test } from '@playwright/test';
import { DEMO_URL } from '../lib/env.ts';

const PAGE = DEMO_URL + '?fecha=2026-11-26';
const go = async (page: import('@playwright/test').Page, hash: string) => {
  await page.goto(PAGE + hash);
  await page.waitForSelector('#tabs [data-k]', { timeout: 90_000 });
  await page.waitForFunction(() => !/Cargando…/.test(document.querySelector('#view')?.textContent ?? ''), null, { timeout: 90_000 });
};
const profile = async (page: import('@playwright/test').Page, role: string, id: string) => {
  await go(page, `#/perfil-360?rol=${role}&jugador=${id}`);
  await page.waitForSelector('.jstate', { timeout: 30_000 });
  return (await page.innerText('.jstate')).replace(/\s+/g, ' ');
};
const failure = async (page: import('@playwright/test').Page, player: string) => {
  await go(page, '#/cola-de-fallas?rol=crm_analyst');
  await page.click(`[data-fopen][aria-label*="${player}"]`);
  // la ruta no cambia entre fallas: esperar a que el panel muestre esta falla y no la anterior
  await expect(page.locator('#fdetail:not([hidden]) h2')).toContainText(player);
  return (await page.innerText('#fdetail')).replace(/\s+/g, ' ');
};

test('Guion T1–T3: estado, próxima acción y motivo de una supresión', async ({ page }) => {
  const t1 = await profile(page, 'crm_analyst', 'acq_affiliate_0010');
  expect(t1).toMatch(/Próxima acción permitida: Invitar al primer depósito/);
  expect(await page.locator('.jstages li[aria-current="step"]').innerText()).toMatch(/Primer depósito/);
  const t2 = await profile(page, 'support', 'acq_org_0013');
  expect(t2).toMatch(/Solo mensajes de servicio/);
  expect(t2).toMatch(/autoexclusión/);
  const t3 = await profile(page, 'crm_analyst', 'acq_meta_0155');
  expect(t3).toMatch(/No contactar por marketing/);
  expect(t3).toMatch(/consentimiento de marketing retirado/);
  expect(await page.locator('.nextact').innerText(), 'el motivo no es juego responsable').not.toMatch(/autoexclusión|juego responsable/);
});

test('Guion T4: simular un recorrido sin efectos externos', async ({ page }) => {
  await go(page, '#/constructor?rol=crm_analyst');
  await page.selectOption('[data-simp="j1_verification"]', 'acq_google_0002');
  await page.click('[data-sim="j1_verification"]');
  await expect(page.locator('[data-simout="j1_verification"] .simres')).toContainText(/sin efectos externos/);
});

test('Guion T5–T8: encontrar una falla, decidir y reprocesar', async ({ page }) => {
  const t5 = await failure(page, 'acq_google_1179');
  expect(t5).toMatch(/no estaba disponible/);
  await page.fill('#frpreason', 'proveedor recuperado');
  await page.check('#frpok');
  await page.click('#frpgo');
  await expect(page.locator('#flash')).toContainText(/Aceptado/);
  const t7 = await failure(page, 'acq_google_0886');
  expect(t7).toMatch(/pudo haber aceptado/);
  expect(t7).toMatch(/Primero se concilia/);
  const t8 = await failure(page, 'acq_google_0709');
  expect(t8).toMatch(/no tiene contacto para sms/i);
  expect(t8).toMatch(/no reproceses/);
});

test('Guion T9: el oficial de juego responsable no ve la cola de fallas', async ({ page }) => {
  await go(page, '#/control-tower?rol=rg_officer');
  await expect(page.locator('#tabs [data-k="rg"]')).toHaveCount(1);
  await expect(page.locator('#tabs [data-k="failures"]')).toHaveCount(0);
});

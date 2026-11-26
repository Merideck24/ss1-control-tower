/**
 * Regresión (CI, flaky en 074a1c7): una revisión en vivo agendada en el Constructor corría después de
 * cambiar de pantalla y rol, avisaba «Tu rol no tiene permiso…» en otra pantalla y repintaba bajo el clic.
 */
import { expect, test } from '@playwright/test';
import { DEMO_URL } from '../lib/env.ts';

test('Cambiar de pantalla justo después de editar en el Constructor no deja avisos ni trabajo pendiente', async ({ page }) => {
  const errs: string[] = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(DEMO_URL + '#/constructor?rol=crm_analyst');
  await page.waitForSelector('#bname', { timeout: 90_000 });
  const reviews: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/journeys/review')) reviews.push(r.url()); });
  await page.fill('#bname', 'Edición rápida');
  await page.click('[data-addn="wait"]');            // agenda una revisión en 250 ms
  await page.evaluate(() => { location.hash = '#/aprobacion?rol=approver'; });
  await page.waitForTimeout(1_000);
  await expect(page.locator('#flash')).toBeHidden();
  expect(await page.$eval('#role', (s) => (s as HTMLSelectElement).value)).toBe('approver');
  expect(errs).toEqual([]);
});

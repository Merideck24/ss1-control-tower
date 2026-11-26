/**
 * Perfil 360, Constructor, aprobación y publicación, simulación sin efectos externos, seguimiento y
 * cierre, por la interfaz real contra web + worker + PostgreSQL.
 */
import { expect, test } from '@playwright/test';
import { api, event } from '../lib/stack.ts';
import { main, open, uid } from './_main.ts';

test('Perfil 360: etapa, pendientes y próxima acción permitida de un jugador', async ({ page }) => {
  const { base } = main();
  const p = uid('p360');
  for (const [t, pl, i] of [['player.registered', { email_masked: 'e***@x.test', country: 'CO', locale: 'es', timezone: 'America/Bogota' }, 1], ['rg.status_changed', { status: 'self_excluded' }, 2]] as const)
    expect((await api(base, 'tenant_admin', 'POST', '/events', event(t, p, pl, `${p}-${i}`))).status).toBeLessThan(300);
  await open(page, base, 'perfil-360', 'support', `&jugador=${p}`);
  await page.waitForSelector('.jstate', { timeout: 30_000 });
  const txt = (await page.innerText('.jstate')).replace(/\s+/g, ' ');
  expect(txt).toMatch(/Próxima acción permitida: Solo mensajes de servicio/);
  expect(txt).toMatch(/autoexclusión/);
  expect(await page.locator('.jstages li[aria-current="step"]').innerText()).toMatch(/Baja/);
});

test('Constructor → aprobación → publicación por la interfaz, con segregación de funciones', async ({ page }) => {
  const { base } = main();
  const id = uid('j_e2e');
  // la analista arma y envía desde el Constructor
  await open(page, base, 'constructor', 'crm_analyst');
  await page.click('#bnew').catch(() => undefined);
  await page.fill('#bid', id);
  await page.fill('#bname', `E2E ${id}`);
  await page.dispatchEvent('#bname', 'change');
  await page.click('#savedraft');
  await expect(page.locator('#draftout')).toContainText(/guardado/, { timeout: 15_000 });
  await page.click('#submit');
  await expect(page.locator('#draftout')).toContainText(/aprobaci/i, { timeout: 15_000 });
  // la analista no puede aprobar
  expect((await api(base, 'crm_analyst', 'POST', `/journeys/${id}/approve`)).status).toBe(403);
  // el aprobador aprueba y publica en Aprobación
  await open(page, base, 'aprobacion', 'approver');
  await page.click(`[data-approve="${id}"]`);
  await expect(page.locator(`[data-publish="${id}"]`)).toBeVisible({ timeout: 15_000 });
  await page.click(`[data-publish="${id}"]`);
  await expect.poll(async () => (await api(base, 'crm_analyst', 'GET', '/journeys')).body.find((j: { id: string; status: string }) => j.id === id)?.status).toBe('published');
  // persiste: está en la base
  const runs = await api(base, 'crm_analyst', 'GET', `/journeys/${id}/runs`);
  expect(runs.body.versions).toEqual([expect.objectContaining({ version: 1, status: 'published' })]);
});

test('Simulación sin efectos externos: no crea envíos, recibos ni instancias', async ({ page }) => {
  const { base } = main();
  const before = await api(base, 'tenant_admin', 'GET', '/control-tower');
  await open(page, base, 'constructor', 'crm_analyst');
  await page.click('[data-sim]');
  await expect(page.locator('[data-simout] .simres').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-simout] .simres').first()).toContainText(/sin efectos externos/);
  const after = await api(base, 'tenant_admin', 'GET', '/control-tower');
  const sum = (d: Record<string, number>) => Object.values(d).reduce((a, b) => a + b, 0);
  expect(sum(after.body.deliveries), 'ningún recibo nuevo').toBe(sum(before.body.deliveries));
});

test('Seguimiento y cierre: el analista ve conteos, solo el admin cierra, con motivo', async ({ page }) => {
  const { base } = main();
  const id = uid('j_close');
  const nodes = [{ id: 'm', type: 'message', channel: 'inapp', template: 'deposit_progress', next: 'e' }, { id: 'e', type: 'exit' }];
  expect((await api(base, 'crm_analyst', 'POST', '/journeys', { id, brand_id: 'rumbawin', name: id, purpose: 'service', trigger: { event_type: 'deposit.settled' }, entry: 'm', nodes })).status).toBeLessThan(300);
  await api(base, 'crm_analyst', 'POST', `/journeys/${id}/submit`);
  await api(base, 'approver', 'POST', `/journeys/${id}/approve`);
  expect((await api(base, 'approver', 'POST', `/journeys/${id}/publish`)).status).toBe(200);
  await open(page, base, 'constructor', 'crm_analyst');
  await page.click(`[data-runs="${id}"]`);
  await expect(page.locator(`[data-runsout="${id}"]`)).toContainText(/Instancias/);
  await expect(page.locator(`[data-close="${id}"]`)).toHaveCount(0);
  page.on('dialog', (d) => d.accept('fin de la prueba e2e'));
  await open(page, base, 'constructor', 'tenant_admin');
  await page.click(`[data-close="${id}"]`);
  await expect(page.locator('#flash')).toContainText(/Recorrido cerrado/);
  await expect.poll(async () => (await api(base, 'crm_analyst', 'GET', `/journeys/${id}/runs`)).body.versions[0].status).toBe('closed');
});

/** Cola de fallas y reproceso contra web + worker + PostgreSQL; exportación CSV. */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { axe } from '../lib/env.ts';
import { api } from '../lib/stack.ts';
import { main, open } from './_main.ts';

const transient = async (base: string) => (await api(base, 'crm_analyst', 'GET', '/failures?status=transitoria')).body.items as { key: string; player_id: string }[];

test('Cola de fallas: un operador encuentra, entiende y reprocesa una falla recuperable', async ({ page }) => {
  const { base } = main();
  const items = await transient(base);
  expect(items.length, 'la historia sintética deja fallas transitorias').toBeGreaterThan(0);
  await open(page, base, 'cola-de-fallas', 'crm_analyst');
  await page.selectOption('#fqf [name=status]', 'transitoria');
  await page.click('#fqf button[type=submit]');
  await page.waitForSelector('[data-fopen]');
  await page.click('[data-fopen]');
  await page.waitForSelector('#fdetail:not([hidden]) #frp');
  await expect(page.locator('#fdetail')).toContainText(/no estaba disponible/);
  await expect(page.locator('#fdetail')).toContainText(/Cómo investigarla/);
  await expect(page.locator('#frpgo')).toBeDisabled();
  expect(await axe(page)).toEqual([]);
  await page.fill('#frpreason', 'el proveedor ya se recuperó (e2e)');
  await page.check('#frpok');
  await page.click('#frpgo');
  await expect(page.locator('#flash')).toContainText(/Aceptado/, { timeout: 15_000 });
  await expect(page.locator('#fdetail')).toContainText(/Reprocesos anteriores/);
  // queda en la base, con su intento
  const key = await page.locator('#fdetail code').first().innerText();
  const f = await api(base, 'crm_analyst', 'GET', `/failures/${encodeURIComponent(key)}`);
  expect([f.body.status, f.body.history.at(-1).actor, f.body.history.at(-1).outcome]).toEqual(['resolved', 'crm_analyst@ss1', 'accepted']);
});

test('Cola de fallas: fuera de ámbito no ve ni ejecuta; dos solicitudes simultáneas → un solo efecto', async () => {
  const { base } = main();
  const [f] = await transient(base);
  test.skip(!f, 'sin fallas transitorias restantes');
  const url = `/failures/${encodeURIComponent(f.key)}/reprocess`;
  expect((await api(base, 'rg_officer', 'GET', '/failures')).status).toBe(403);
  expect((await api(base, 'auditor', 'POST', url, { reason: 'x', confirm: true })).status).toBe(403);
  expect((await api(base, 'crm_analyst', 'GET', `/failures/${encodeURIComponent(f.key)}`, undefined, 'tenant-demo-b')).status).toBe(404);
  const [a, b] = await Promise.all([api(base, 'crm_analyst', 'POST', url, { reason: 'a', confirm: true }), api(base, 'tenant_admin', 'POST', url, { reason: 'b', confirm: true })]);
  const codes = [a.status, b.status].sort();
  expect(codes, JSON.stringify([a.body, b.body])).toEqual([200, 409]);
  const done = await api(base, 'crm_analyst', 'GET', `/failures/${encodeURIComponent(f.key)}`);
  expect(done.body.history.length, 'un solo intento registrado').toBe(1);
});

test('Exportación CSV: la tabla de la cola se descarga con encabezados y sin correos', async ({ page }) => {
  const { base } = main();
  await open(page, base, 'cola-de-fallas', 'crm_analyst');
  const btn = page.locator('.card .csvbtn').filter({ hasText: 'CSV' }).last();
  await expect(btn).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent('download'), btn.click()]);
  const csv = readFileSync((await dl.path())!, 'utf8');
  const [head, ...rows] = csv.trim().split(/\r?\n/);
  expect(head).toMatch(/Fecha.*Jugador.*Recorrido.*Paso.*Canal.*Motivo/);
  expect(rows.length).toBeGreaterThan(0);
  expect(csv).not.toMatch(/[\w.]+@[\w-]+\.\w+/);
  // la API también exporta CSV
  const r = await api(base, 'analytics_reader', 'GET', '/analytics/journey-impact?format=csv');
  const r2 = r.status === 200 ? r : await api(base, 'crm_analyst', 'GET', '/analytics/journey-impact?format=csv');
  expect(r2.status).toBe(200);
  expect(r2.text.split('\n')[0]).toMatch(/^recorrido,nombre,ventana_dias/);
});

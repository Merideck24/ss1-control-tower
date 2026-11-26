/** Acceso a la pila principal que arrancó global-setup (o se omite si no hay PostgreSQL de prueba). */
import { test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/env.ts';
import { E2E_DB } from '../lib/stack.ts';

export const STATE = join(ROOT, 'test-results', 'e2e-stack.json');
export function main(): { base: string; dbUrl: string } {
  test.skip(!E2E_DB || !existsSync(STATE), 'Sin E2E_DATABASE_URL: la pila con PostgreSQL no se arrancó');
  return JSON.parse(readFileSync(STATE, 'utf8'));
}
/** Abre una pantalla con rol (y tenant) por la URL, como lo hace la demo integrada. */
export async function open(page: import('@playwright/test').Page, base: string, slug: string, role: string, extra = '') {
  await page.goto(`${base}/#/${slug}?rol=${role}${extra}`);
  await page.waitForSelector('#tabs [data-k]', { timeout: 60_000 });
  await page.waitForFunction(() => !/Cargando…/.test(document.querySelector('#view')?.textContent ?? ''), null, { timeout: 60_000 });
}
/** Id único por prueba: los datos de una prueba no interfieren con los de otra. */
export const uid = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

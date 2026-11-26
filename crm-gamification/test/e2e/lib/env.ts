/** Utilidades comunes de las pruebas de navegador. */
import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
export const ROOT = join(import.meta.dirname, '..', '..', '..');
/** axe-core 4.10.2 (dependencia de desarrollo), inyectado en la página para revisar accesibilidad. */
export const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
/** La demo publicada: el mismo build estático que sirve GitHub Pages (npm run build:static). */
export const DEMO_URL = pathToFileURL(join(ROOT, 'dist', 'index.html')).toString();

/** Cierre de los scripts trasladados: ninguna comprobación FAIL y ningún error de JavaScript. */
export function finish(out: string[], errs: string[]) {
  const fails = out.filter((l) => l.startsWith('FAIL'));
  expect(fails, `comprobaciones fallidas:\n${fails.join('\n')}`).toEqual([]);
  expect(errs, 'errores de JavaScript en la página').toEqual([]);
}

/** Violaciones de axe en un selector (lista vacía = sin violaciones). */
export async function axe(page: import('@playwright/test').Page, selector = '#view'): Promise<string[]> {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async (sel) => (await (window as unknown as { axe: { run: (s: string) => Promise<{ violations: { id: string; nodes: { html: string }[] }[] }> } }).axe.run(sel)).violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 100)}`), selector);
}

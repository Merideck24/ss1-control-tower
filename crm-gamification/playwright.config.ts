/**
 * Pruebas de navegador (test/e2e). Dos proyectos:
 *  · demo  — la demo publicada (build estático de npm run build:static), sin servidor.
 *  · stack — web y worker reales sobre PostgreSQL de prueba (E2E_DATABASE_URL), datos sintéticos.
 *
 *   npm run build:static && E2E_DATABASE_URL=postgres://… npm run e2e
 *
 * Trazas, capturas y registros de los servicios quedan en test-results/ cuando algo falla.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './test/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: 'test-results/e2e',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 950 },
  },
  projects: [
    { name: 'demo', testDir: 'test/e2e/demo' },
    { name: 'stack', testDir: 'test/e2e/stack' },
  ],
});

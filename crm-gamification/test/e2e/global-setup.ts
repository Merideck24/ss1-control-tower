/**
 * Arranca la pila principal para el proyecto «stack»: base nueva y migrada, web (CRM_ROLE=web) con
 * 90 días de datos sintéticos y un worker independiente. Sin E2E_DATABASE_URL, las pruebas de la
 * pila se omiten y solo corre el proyecto «demo».
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, E2E_DB, stackFor, startWeb, startWorker, type Stack } from './lib/stack.ts';
import { ROOT } from './lib/env.ts';

export const MAIN_PORT = 3410;
export const STATE = join(ROOT, 'test-results', 'e2e-stack.json');

export default async function globalSetup() {
  if (!E2E_DB) { console.log('[e2e] sin E2E_DATABASE_URL: se omite la pila con PostgreSQL'); return; }
  const s: Stack = stackFor('main', MAIN_PORT, join(ROOT, 'test-results', 'stack-logs'));
  s.dbUrl = await createDb('crm_e2e_main');
  await startWeb(s, { CRM_DEMO_SEED: '1' });
  await startWorker(s);
  writeFileSync(STATE, JSON.stringify({ base: s.base, dbUrl: s.dbUrl, pids: [s.web!.pid, s.worker!.pid] }));
  console.log(`[e2e] pila lista en ${s.base} (web ${s.web!.pid}, worker ${s.worker!.pid})`);
  return async () => {
    for (const p of [s.web, s.worker]) if (p && p.exitCode === null) p.kill('SIGTERM');
  };
}

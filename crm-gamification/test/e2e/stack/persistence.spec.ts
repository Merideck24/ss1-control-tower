/**
 * Persistencia tras reinicio: pila propia (web + worker, base propia). Una espera queda guardada, se
 * detienen los dos procesos mientras vence, y al volver el worker la despierta una sola vez y la web
 * lo muestra. Un segundo reinicio no reenvía.
 */
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import pg from 'pg';
import { ROOT } from '../lib/env.ts';
import { api, createDb, E2E_DB, event, stackFor, startWeb, startWorker, stopStack } from '../lib/stack.ts';
import { open } from './_main.ts';

test('Persistencia: instancias en espera y recibos sobreviven al reinicio de la web y del worker', async ({ page }) => {
  test.skip(!E2E_DB, 'Sin E2E_DATABASE_URL');
  test.setTimeout(300_000);
  const s = stackFor('restart', 3420, join(ROOT, 'test-results', 'stack-logs'));
  s.dbUrl = await createDb('crm_e2e_restart');
  const db = new pg.Client({ connectionString: s.dbUrl }); await db.connect();
  try {
    await startWeb(s); await startWorker(s);
    const nodes = [{ id: 'w', type: 'wait', duration_ms: 4_000, next: 'm' }, { id: 'm', type: 'message', channel: 'email', template: 'deposit_progress', next: 'e' }, { id: 'e', type: 'exit' }];
    expect((await api(s.base, 'crm_analyst', 'POST', '/journeys', { id: 'j_restart', brand_id: 'rumbawin', name: 'Reinicio', purpose: 'service', trigger: { event_type: 'deposit.settled' }, entry: 'w', nodes })).status).toBeLessThan(300);
    await api(s.base, 'crm_analyst', 'POST', '/journeys/j_restart/submit');
    await api(s.base, 'approver', 'POST', '/journeys/j_restart/approve');
    expect((await api(s.base, 'approver', 'POST', '/journeys/j_restart/publish')).status).toBe(200);
    for (const [t, pl, i] of [['player.registered', { email_masked: 'r***@x.test', country: 'CO', locale: 'es', timezone: 'America/Bogota' }, 1], ['rg.status_changed', { status: 'none' }, 2], ['deposit.settled', { deposit_id: 'rd1', amount_minor: 5_000_000, currency: 'COP' }, 3]] as const)
      expect((await api(s.base, 'tenant_admin', 'POST', '/events', event(t, 'rst1', pl, `rst-${i}`))).status).toBeLessThan(300);
    await expect.poll(async () => (await db.query(`SELECT status FROM journey_instances WHERE journey_id = 'j_restart'`)).rows[0]?.status, { timeout: 10_000 }).toBe('waiting');
    // los dos procesos caen y el plazo vence mientras están caídos
    await stopStack(s);
    await new Promise((r) => setTimeout(r, 5_000));
    await startWeb(s); await startWorker(s);
    await expect.poll(async () => (await db.query(`SELECT status FROM journey_instances WHERE journey_id = 'j_restart'`)).rows[0]?.status, { timeout: 20_000 }).toBe('completed');
    const rec = (await db.query(`SELECT idempotency_key, status, journey_version, node_id FROM delivery_receipts WHERE journey_id = 'j_restart'`)).rows;
    expect(rec.map((r) => [r.status, r.journey_version, r.node_id])).toEqual([['accepted', 1, 'm']]);
    // la web lo muestra en Seguimiento
    await open(page, s.base, 'constructor', 'crm_analyst');
    await expect.poll(async () => { await page.reload(); await page.waitForSelector('[data-runs="j_restart"]'); await page.click('[data-runs="j_restart"]'); return (await page.locator('[data-runsout="j_restart"]').innerText()).replace(/\s+/g, ' '); }, { timeout: 20_000 }).toMatch(/Completadas: 1/);
    // segundo reinicio: sin reenvío
    await stopStack(s); await startWeb(s); await startWorker(s);
    await new Promise((r) => setTimeout(r, 2_000));
    expect((await db.query(`SELECT count(*)::int AS n, max(attempts) AS a FROM delivery_receipts WHERE journey_id = 'j_restart'`)).rows[0]).toEqual({ n: 1, a: 1 });
  } finally {
    await db.end();
    await stopStack(s);
  }
});

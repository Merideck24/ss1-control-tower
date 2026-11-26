/**
 * Prueba de contrato con el PAM de SS1.
 *
 *   npm run pam:contract                      # fixtures sintéticos (test/fixtures/pam), sin red
 *   SS1_API_BASE=https://… SS1_API_TOKEN=…    # entorno autorizado: primero GET /admin/auth/me
 *     npm run pam:contract -- --live --out /ruta/fuera/del/repo/informe.json
 *
 * El token se lee del entorno, nunca de argumentos, y no aparece en la salida. El informe está
 * redactado: ids, campos, códigos y conteos, sin datos personales. Con --live la salida por
 * defecto va a la consola; guárdala fuera del repositorio.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp, seedTenant } from '../src/app.ts';
import { SandboxPam } from '../src/integration/pam.ts';
import { probeCredential, runPamContract } from '../src/integration/pamContract.ts';
import { Ss1Client } from '../src/integration/ss1Client.ts';
import { ManualClock } from '../src/shared/util.ts';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const live = args.includes('--live');
const tenant = process.env.CRM_TENANT ?? 'tenant-rumbawin', brand = process.env.CRM_BRAND ?? 'rumbawin';
const client = process.env.SS1_CLIENT_ID ?? '3';
const app = createApp(new ManualClock(new Date().toISOString()));
seedTenant(app, tenant);

let report;
if (live) {
  const apiBase = process.env.SS1_API_BASE, token = process.env.SS1_API_TOKEN;
  if (!apiBase || !token) { console.error('Faltan SS1_API_BASE y SS1_API_TOKEN en el entorno (la credencial va por el gestor de secretos, nunca en argumentos).'); process.exit(2); }
  const tenantMap = { [client]: tenant };
  const probe = await probeCredential({ apiBase, token, tenantMap, expectTenant: tenant });
  report = await runPamContract({ mode: 'ss1', host: new URL(apiBase).host, probe, source: new Ss1Client({ apiBase, token }), ingestor: app.ingestor, tenant, brand, client });
} else {
  const dir = opt('--fixtures') ?? join(import.meta.dirname, '../test/fixtures/pam');
  const load = async (n: string) => JSON.parse(await readFile(join(dir, `${n}.json`), 'utf8'));
  const auth = await load('auth_me_ok');
  const probe = await probeCredential({ apiBase: 'https://fixtures.invalid', token: 'fixture-token-0000', tenantMap: { [client]: tenant }, expectTenant: tenant, fetchImpl: (async () => Response.json(auth)) as unknown as typeof fetch });
  const source = new SandboxPam({ players: await load('players'), financial: await load('financial'), withdrawals: await load('withdrawals'), games: await load('games') }, { pageSize: 4 });
  report = await runPamContract({ mode: 'fixtures', probe, source, ingestor: app.ingestor, tenant, brand, client });
}
const text = JSON.stringify(report, null, 2);
const out = opt('--out');
if (out) { await writeFile(out, text); console.log(`Informe (${report.verdict}) en ${out}`); } else console.log(text);
process.exit(report.verdict === 'detenido' ? 3 : 0);

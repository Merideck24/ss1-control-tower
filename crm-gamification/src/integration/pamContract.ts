/**
 * Prueba de contrato con el PAM de SS1 (Fase 2, docs/PAM_INTEGRATION.md §8).
 *
 *  1. `probeCredential` llama a GET /admin/auth/me ANTES de leer datos: identidad, permisos,
 *     tenant y ausencia de permisos de escritura. Si algo no cuadra, la prueba se detiene.
 *  2. `validateRows` contrasta filas (reales anonimizadas o sintéticas) con el esquema que el
 *     CRM espera de cada recurso: obligatorios, nulos, enumeraciones, fechas, identificadores,
 *     tenant y marca. El informe es REDACTADO: nombra filas por posición e id, campos y códigos,
 *     nunca valores personales ni la credencial.
 */
import type { CaslRule } from './ss1Auth.ts';
import { extractProfile } from './ss1Identity.ts';
import type { ConnectorName } from './ss1Connectors.ts';
import type { PamSource } from './pam.ts';
import { CONNECTORS, connectorQuery, runConnector, SS1_ENDPOINTS, type SyncReport } from './ss1Connectors.ts';
import type { Ingestor } from '../ingestion/ingestor.ts';

export type ProbeResult = {
  ok: boolean;
  status: number;
  /** Lo que la credencial dice ser. Nada de esto es secreto. */
  identity?: { user_id: string; client?: string; tenant?: string };
  read_subjects: string[];
  write_rules: number;
  /** Diferencias entre el contrato supuesto y la respuesta real. */
  drift: string[];
  stop_reason?: string;
};

const WRITE = new Set(['create', 'update', 'delete', 'manage', 'write']);

export async function probeCredential(o: { apiBase: string; token: string; profilePath?: string; tenantMap?: Record<string, string>; expectTenant?: string; fetchImpl?: typeof fetch }): Promise<ProbeResult> {
  const f = o.fetchImpl ?? fetch;
  const base: ProbeResult = { ok: false, status: 0, read_subjects: [], write_rules: 0, drift: [] };
  let res: Response;
  try {
    res = await f(o.apiBase + (o.profilePath ?? '/admin/auth/me'), { headers: { authorization: `Bearer ${o.token}`, accept: 'application/json' } });
  } catch (e) {
    return { ...base, stop_reason: `sin conexión con el entorno (${(e as Error).name})` };
  }
  base.status = res.status;
  if (res.status === 401) return { ...base, stop_reason: 'credencial inválida o caducada (401)' };
  if (res.status === 403) return { ...base, stop_reason: 'credencial válida sin permiso para /admin/auth/me (403)' };
  if (res.status === 404) return { ...base, stop_reason: 'GET /admin/auth/me no existe en este entorno (404)' };
  if (!res.ok) return { ...base, stop_reason: `respuesta inesperada ${res.status}` };
  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  const p = extractProfile(body);
  if (!p) return { ...base, drift: ['la respuesta no trae un usuario reconocible (userData.id / id)'], stop_reason: 'identidad no reconocible' };
  const drift: string[] = [];
  const root = (body && 'data' in body ? body.data : body) as Record<string, unknown>;
  if (!('userData' in root)) drift.push('el usuario no viene en `userData` (se aceptó otra forma)');
  if (!('userAbilities' in root)) drift.push('los permisos no vienen en `userAbilities`');
  if (!p.client) drift.push('no trae cliente (tenant): userData.clientId / client_id');
  const rules: CaslRule[] = p.rules;
  const write = rules.filter((r) => WRITE.has(String(r.action).toLowerCase()));
  const read = [...new Set(rules.filter((r) => String(r.action).toLowerCase() === 'read').map((r) => String(r.subject)))].sort();
  const tenant = p.client ? (o.tenantMap?.[p.client] ?? p.client) : undefined;
  const out: ProbeResult = { ok: true, status: res.status, identity: { user_id: p.userId, client: p.client, tenant }, read_subjects: read, write_rules: write.length, drift };
  if (write.length) return { ...out, ok: false, stop_reason: `la credencial tiene ${write.length} permiso(s) de escritura: se pide una de solo lectura` };
  if (o.expectTenant && tenant !== o.expectTenant) return { ...out, ok: false, stop_reason: `la credencial es del tenant «${tenant ?? '—'}», no de «${o.expectTenant}»` };
  if (!read.length) drift.push('no declara permisos de lectura (userAbilities vacío)');
  return out;
}

// ───────────── Esquemas que el CRM espera de cada recurso ─────────────

type FieldRule = { required?: boolean; nullable?: boolean; kind: 'id' | 'date' | 'money' | 'text' | 'bool' | 'object'; enum?: (string | number)[]; alt?: string[] };
export const PAM_SCHEMAS: Record<ConnectorName, Record<string, FieldRule>> = {
  players: {
    id: { required: true, kind: 'id' },
    created_at: { required: true, kind: 'date', alt: ['registered_at'] },
    username: { kind: 'text', nullable: true },
    country: { kind: 'text', nullable: true },
    kyc_status: { kind: 'text', nullable: true, enum: ['approved', 'verified', 'completed', 'pending', 'unverified', 'rejected'] },
    responsible_gaming: { kind: 'object', nullable: true },
    updated_at: { kind: 'date', nullable: true },
    client: { kind: 'id', nullable: true },
  },
  financial: {
    id: { required: true, kind: 'id' },
    player_id: { required: true, kind: 'id' },
    transaction_type: { required: true, kind: 'text', enum: [1, 2, 3, 4, 'deposit', 'withdrawal', 'bonus', 'adjustment'] },
    status: { required: true, kind: 'text', enum: [0, 1, 2, 'failed', 'pending', 'completed'] },
    amount: { required: true, kind: 'money' },
    currency: { required: true, kind: 'text' },
    created_at: { required: true, kind: 'date' },
  },
  withdrawals: {
    id: { required: true, kind: 'id' },
    player_id: { required: true, kind: 'id' },
    amount: { required: true, kind: 'money' },
    currency: { required: true, kind: 'text' },
    status: { kind: 'text', nullable: true },
    created_at: { required: true, kind: 'date' },
  },
  games: {
    id: { required: true, kind: 'id' },
    transaction_type: { required: true, kind: 'text', enum: ['DEBIT', 'CREDIT', 'ROLLBACK', 'FREE_SPIN'] },
    amount: { required: true, kind: 'money' },
    currency: { required: true, kind: 'text' },
    player: { required: true, kind: 'text' },
    status: { required: true, kind: 'bool' },
    created_at: { required: true, kind: 'date' },
  },
};

export type RowIssue = { row: number; id?: string; field: string; code: 'missing' | 'null' | 'enum' | 'date' | 'id' | 'money' | 'type' | 'tenant' | 'unknown_player'; detail: string };
export type ValidationReport = { resource: ConnectorName; rows: number; valid: number; issues: RowIssue[]; unknown_fields: string[]; by_code: Record<string, number> };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const scalar = (v: unknown) => (isObj(v) ? (v.value ?? v.iso ?? v.code ?? v.id ?? v.raw) : v);
const okDate = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v.includes('T') || !v.includes(' ') ? v : v.replace(' ', 'T') + 'Z'));
const okMoney = (v: unknown) => { const s = String(scalar(v) ?? ''); return /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/.test(s); };

/**
 * Valida filas contra el esquema. `ctx.client` es el cliente esperado (tenant); una fila que
 * declare otro cliente es un error de tenant. `ctx.players` (ids conocidos) detecta movimientos
 * de jugadores que no llegaron en el recurso de jugadores.
 */
export function validateRows(resource: ConnectorName, rows: unknown[], ctx: { client?: string; players?: Set<string>; usernames?: Set<string> } = {}): ValidationReport {
  const schema = PAM_SCHEMAS[resource];
  const issues: RowIssue[] = [];
  const unknown = new Set<string>();
  let valid = 0;
  rows.forEach((raw, i) => {
    const before = issues.length;
    if (!isObj(raw)) { issues.push({ row: i, field: '*', code: 'type', detail: 'la fila no es un objeto' }); return; }
    const id = raw.id === undefined || raw.id === null ? undefined : String(raw.id);
    for (const [field, rule] of Object.entries(schema)) {
      const present = [field, ...(rule.alt ?? [])].find((k) => k in raw);
      const v = present ? raw[present] : undefined;
      if (v === undefined) { if (rule.required) issues.push({ row: i, id, field, code: 'missing', detail: 'campo obligatorio ausente' }); continue; }
      if (v === null || v === '') { if (!rule.nullable) issues.push({ row: i, id, field, code: 'null', detail: rule.required ? 'obligatorio vacío' : 'vacío en un campo no anulable' }); continue; }
      const s = scalar(v);
      if (rule.kind === 'id' && !/^[\w-]{1,64}$/.test(String(s))) issues.push({ row: i, id, field, code: 'id', detail: 'identificador con formato inesperado' });
      if (rule.kind === 'date' && !okDate(v)) issues.push({ row: i, id, field, code: 'date', detail: 'fecha no interpretable' });
      if (rule.kind === 'money' && !okMoney(v)) issues.push({ row: i, id, field, code: 'money', detail: 'monto no numérico' });
      if (rule.kind === 'bool' && typeof v !== 'boolean' && ![0, 1, '0', '1'].includes(v as never)) issues.push({ row: i, id, field, code: 'type', detail: 'se esperaba verdadero/falso' });
      if (rule.kind === 'object' && !isObj(v)) issues.push({ row: i, id, field, code: 'type', detail: 'se esperaba un objeto' });
      if (rule.enum) {
        const norm = typeof s === 'string' ? (resource === 'games' ? s.toUpperCase() : s.toLowerCase()) : s;
        // el valor de una enumeración no es dato personal: se informa para poder mapearlo
        if (!rule.enum.includes(norm as never)) issues.push({ row: i, id, field, code: 'enum', detail: `valor fuera del catálogo: ${JSON.stringify(s).slice(0, 24)}` });
      }
    }
    if (ctx.client && 'client' in raw && raw.client !== null && String(scalar(raw.client)) !== ctx.client) issues.push({ row: i, id, field: 'client', code: 'tenant', detail: 'la fila es de otro cliente' });
    if (ctx.players && 'player_id' in raw && raw.player_id !== null && !ctx.players.has(String(raw.player_id))) issues.push({ row: i, id, field: 'player_id', code: 'unknown_player', detail: 'jugador que no llegó en el recurso de jugadores' });
    if (ctx.usernames && resource === 'games' && typeof raw.player === 'string' && !ctx.usernames.has(raw.player)) issues.push({ row: i, id, field: 'player', code: 'unknown_player', detail: 'username sin jugador mapeado' });
    for (const k of Object.keys(raw)) if (!(k in schema) && !Object.values(schema).some((r) => r.alt?.includes(k))) unknown.add(k);
    if (issues.length === before) valid++;
  });
  const by_code: Record<string, number> = {};
  for (const x of issues) by_code[x.code] = (by_code[x.code] ?? 0) + 1;
  return { resource, rows: rows.length, valid, issues, unknown_fields: [...unknown].sort(), by_code };
}

// ───────────── Corrida completa (fixtures o entorno autorizado) ─────────────


export type ContractReport = {
  mode: 'fixtures' | 'ss1';
  host?: string;
  at: string;
  probe: ProbeResult;
  validation: ValidationReport[];
  sync: SyncReport[];
  discrepancies: { resource: string; code: string; count: number; decision: string }[];
  verdict: 'aprobado' | 'con_discrepancias' | 'detenido';
};

/** Qué hace el CRM con cada tipo de discrepancia (se documenta en el informe). */
const DECISION: Record<string, string> = {
  missing: 'La fila se omite con motivo; SS1 confirma si el campo es realmente obligatorio',
  null: 'Se trata como ausente; si es obligatorio, la fila se omite con motivo',
  enum: 'Valor nuevo: se agrega al mapeo o se omite con motivo hasta que SS1 confirme su significado',
  date: 'La fila se omite: sin fecha no hay orden ni ventanas',
  id: 'La fila se omite: el id es la llave de idempotencia',
  money: 'La fila se omite: un monto no interpretable no entra a los totales',
  type: 'La fila se omite con motivo',
  tenant: 'La fila se descarta: pertenece a otro cliente; SS1 revisa el alcance de la credencial',
  unknown_player: 'El movimiento se omite hasta que llegue el jugador (orden de conectores: jugadores primero)',
};

export async function runPamContract(o: { mode: 'fixtures' | 'ss1'; host?: string; probe: ProbeResult; source: PamSource; ingestor: Ingestor; tenant: string; brand: string; client?: string; now?: () => Date }): Promise<ContractReport> {
  const at = (o.now?.() ?? new Date()).toISOString();
  if (!o.probe.ok) return { mode: o.mode, host: o.host, at, probe: o.probe, validation: [], sync: [], discrepancies: [], verdict: 'detenido' };
  const validation: ValidationReport[] = [];
  const players = new Set<string>(), usernames = new Set<string>();
  const rowsOf = async (c: ConnectorName) => { const out: Record<string, unknown>[] = []; for await (const r of o.source.paginate(SS1_ENDPOINTS[c], connectorQuery(c))) out.push(r); return out; };
  for (const c of CONNECTORS) {
    const rows = await rowsOf(c);
    if (c === 'players') for (const r of rows) { if (r.id != null) players.add(String(r.id)); if (typeof r.username === 'string') usernames.add(r.username); }
    validation.push(validateRows(c, rows, { client: o.client, players: c === 'players' ? undefined : players, usernames: c === 'games' ? usernames : undefined }));
  }
  const ctx = { tenant_id: o.tenant, brand_id: o.brand, client: o.client, usernames: new Map<string, string>() };
  const sync: SyncReport[] = [];
  for (const c of CONNECTORS) sync.push(await runConnector(c, o.source, o.ingestor, ctx, connectorQuery(c)));
  const discrepancies = validation.flatMap((v) => Object.entries(v.by_code).map(([code, count]) => ({ resource: v.resource, code, count, decision: DECISION[code] ?? 'Revisar' })));
  const verdict = discrepancies.length || sync.some((s) => s.error) ? 'con_discrepancias' : 'aprobado';
  return { mode: o.mode, host: o.host, at, probe: o.probe, validation, sync, discrepancies, verdict };
}

/**
 * Conectores admin.syssoft1.com → eventos normalizados del CRM.
 * Los event_id son deterministas (ss1:<recurso>:<id>:<tipo>) para que una resincronización
 * sea idempotente. El contrato sale del código del propio admin (docs/SS1_DATA_CONTRACT.md):
 * códigos numéricos en transacciones financieras, `country.value`, `responsible_gaming` y
 * movimientos de juego DEBIT/CREDIT/ROLLBACK/FREE_SPIN. Se aceptan también las formas de texto.
 */
import type { PamSource } from './pam.ts';
import type { EventEnvelope } from '../domain/events.ts';
import type { Ingestor } from '../ingestion/ingestor.ts';
import { Ss1ApiError, toMinor } from './ss1Client.ts';

export const SS1_ENDPOINTS = {
  players: (typeof process !== 'undefined' ? process.env.SS1_PLAYERS_PATH : undefined) ?? '/admin/players',
  financial: '/admin/transactions/financial',
  withdrawals: '/admin/withdrawal-requests',
  /** movimientos de juego (apuestas y premios), el mismo listado de la vista Transacciones del admin */
  games: '/admin/transactions/report/all',
  triggerCatalog: '/admin/bonus-campaigns/trigger-catalog',
  /** reportes del admin para conciliar (fase 1 de la hoja de ruta) */
  reportDailyBrands: '/admin/transactions/report/daily/brands',
  reportPlayers: '/admin/transactions/report/players',
};

/** Códigos del admin (vista Transacciones financieras). */
export const SS1_FINANCIAL_TYPE: Record<number, string> = { 1: 'deposit', 2: 'withdrawal', 3: 'bonus', 4: 'adjustment' };
export const SS1_FINANCIAL_STATUS: Record<number, string> = { 0: 'failed', 1: 'pending', 2: 'completed' };

type Row = Record<string, unknown>;
const str = (...vs: unknown[]) => { for (const v of vs) if (v !== undefined && v !== null && v !== '') return String(v); return undefined; };
const iso = (v: unknown) => { const t = Date.parse(String(v ?? '')); return Number.isNaN(t) ? undefined : new Date(t).toISOString(); };
const pick = (r: Row, path: string) => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Row)[k] : undefined), r);

export type MapContext = {
  tenant_id: string; brand_id: string; country?: string; timezone?: string;
  /** Cliente del admin que corresponde a este tenant. Una fila que declare otro cliente se descarta. */
  client?: string;
  /** username → id del jugador. Los movimientos de juego del admin traen el username; lo llena el conector de jugadores. */
  usernames?: Map<string, string>;
};

/** Un código ISO desde texto u objeto del admin ({ value }, { iso }, { code }). */
const code = (v: unknown): string | undefined => (v && typeof v === 'object' ? str((v as Row).value, (v as Row).iso, (v as Row).code, (v as Row).iso_code) : str(v));
/** Monto en texto/número o como objeto { raw } de los reportes del admin. */
const amountOf = (v: unknown): unknown => (v && typeof v === 'object' && 'raw' in (v as Row) ? (v as Row).raw : v);
export type MapResult = { events: EventEnvelope[]; skipped: { id?: string; reason: string }[] };

const base = (ctx: MapContext, source: string, id: string, type: EventEnvelope['event_type'], player: string, at: string) =>
  ({ event_id: `ss1:${id}:${type}`, event_type: type, schema_version: 1, tenant_id: ctx.tenant_id, brand_id: ctx.brand_id, player_id: player, occurred_at: at, source, correlation_id: `ss1:${id}` }) as const;

/** Jugador → player.registered (+ player.verified si el KYC está aprobado). */
export function mapPlayer(r: Row, ctx: MapContext): MapResult {
  const id = str(r.id, r.player_id, r.uuid);
  const at = iso(r.created_at ?? r.registered_at);
  if (!id || !at) return { events: [], skipped: [{ id, reason: 'player sin id o fecha' }] };
  const rowClient = code(r.client ?? r.client_id);
  if (ctx.client && rowClient && rowClient !== ctx.client) return { events: [], skipped: [{ id, reason: 'jugador de otro cliente: no pertenece a este tenant' }] };
  const email = str(r.email);
  const masked = email ? email.replace(/^(.).*(@.*)$/, '$1***$2') : 'oculto';
  const username = str(r.username);
  if (username && ctx.usernames) ctx.usernames.set(username, id);
  const events: EventEnvelope[] = [{ ...base(ctx, 'ss1.admin', `player:${id}`, 'player.registered', id, at), payload: { email_masked: masked, country: (code(r.country) ?? str(r.country_iso, r.country_code, ctx.country) ?? 'CO').toUpperCase(), locale: (str(r.locale, r.language) ?? 'es').slice(0, 2), timezone: str(r.timezone, ctx.timezone) ?? 'America/Bogota', ...(str(r.affiliate_id, pick(r, 'affiliate.id'), r.campaign_id) ? { acquisition: { campaign_id: str(r.campaign_id, r.affiliate_id, pick(r, 'affiliate.id'))!, channel: str(r.channel) ?? 'affiliate' } } : {}) } } as EventEnvelope];
  const kyc = str(r.kyc_status, pick(r, 'kyc.status'))?.toLowerCase();
  if (kyc && ['approved', 'verified', 'completed'].includes(kyc)) events.push({ ...base(ctx, 'ss1.admin', `player:${id}`, 'player.verified', id, iso(r.kyc_verified_at ?? pick(r, 'kyc.updated_at')) ?? at), payload: { kyc_status: 'verified' } } as EventEnvelope);
  // Juego responsable: autoexclusión vigente o límites de depósito. El id incluye el estado para registrar cada cambio una vez.
  const rg = (r.responsible_gaming ?? {}) as Row;
  const until = iso(rg.self_excluded_until ?? r.self_excluded_until);
  const status = until && Date.parse(until) > Date.now() ? 'self_excluded' : rg.has_deposit_limits ? 'limited' : undefined;
  if (status) events.push({ ...base(ctx, 'ss1.admin', `player:${id}:rg:${status}:${until ?? ''}`, 'rg.status_changed', id, iso(r.updated_at) ?? at), payload: { status } } as EventEnvelope);
  return { events, skipped: [] };
}

/** Transacción financiera → deposit.settled / deposit.reversed / withdrawal.settled. */
export function mapFinancial(r: Row, ctx: MapContext): MapResult {
  const id = str(r.id, r.transaction_id, r.uuid);
  const player = str(r.player_id, pick(r, 'player.id'), r.user_id);
  const currency = (code(r.currency) ?? str(r.currency_iso, r.currency_code) ?? '').toUpperCase();
  const rawType = r.transaction_type ?? r.type ?? r.operation ?? r.kind;
  const type = (typeof rawType === 'number' || /^\d+$/.test(String(rawType ?? '')) ? SS1_FINANCIAL_TYPE[Number(rawType)] : str(rawType))?.toLowerCase() ?? '';
  const rawStatus = r.status ?? r.state;
  const status = (typeof rawStatus === 'number' || /^\d+$/.test(String(rawStatus ?? '')) ? SS1_FINANCIAL_STATUS[Number(rawStatus)] : str(rawStatus))?.toLowerCase() ?? '';
  const at = iso(r.processed_at ?? r.completed_at ?? r.updated_at ?? r.created_at);
  if (!id || !player || !/^[A-Z]{3}$/.test(currency) || !at) return { events: [], skipped: [{ id, reason: 'transacción incompleta' }] };
  let amount: number;
  try { amount = Math.abs(toMinor(r.amount ?? r.value, currency)); } catch (e) { return { events: [], skipped: [{ id, reason: (e as Error).message }] }; }
  const ok = ['approved', 'completed', 'success', 'paid', 'settled', 'confirmed'].includes(status);
  const reversed = ['reversed', 'refunded', 'chargeback', 'cancelled_after_payment'].includes(status);
  if (type.includes('deposit')) {
    if (ok) return { events: [{ ...base(ctx, 'ss1.payments', `txn:${id}`, 'deposit.settled', player, at), payload: { deposit_id: id, amount_minor: amount, currency } } as EventEnvelope], skipped: [] };
    if (reversed) return { events: [{ ...base(ctx, 'ss1.payments', `txn:${id}`, 'deposit.reversed', player, at), payload: { deposit_id: id, amount_minor: amount, currency } } as EventEnvelope], skipped: [] };
    return { events: [], skipped: [{ id, reason: `depósito en estado ${status || 'desconocido'}` }] };
  }
  if (type.includes('withdraw')) {
    if (ok) return { events: [{ ...base(ctx, 'ss1.payments', `txn:${id}`, 'withdrawal.settled', player, at), payload: { withdrawal_id: id, amount_minor: amount, currency } } as EventEnvelope], skipped: [] };
    return { events: [], skipped: [{ id, reason: `retiro en estado ${status || 'desconocido'}` }] };
  }
  return { events: [], skipped: [{ id, reason: `tipo no soportado: ${type || (rawType === undefined || rawType === null || rawType === '' ? 'vacío' : `código ${String(rawType).slice(0, 12)} desconocido`)}` }] };
}

/**
 * Movimiento de juego → bet.settled, uno por movimiento, con la definición de beneficio del admin:
 * apostado − premios − reversiones, solo movimientos confirmados por la wallet.
 * DEBIT: apuesta (stake). CREDIT: premio (win). ROLLBACK: devuelve una apuesta (stake negativo).
 * FREE_SPIN: la apuesta de un giro gratis no se cobra ni cuenta como apostado; se omite.
 */
export function mapGameTransaction(r: Row, ctx: MapContext): MapResult {
  const id = str(r.id, r.transaction_id);
  const type = str(r.transaction_type, r.type)?.toUpperCase() ?? '';
  const ref = r.player && typeof r.player === 'object' ? (r.player as Row) : undefined;
  const username = str(ref?.username, typeof r.player === 'string' ? r.player : undefined, r.username);
  const player = str(r.player_id, ref?.id) ?? (username ? ctx.usernames?.get(username) : undefined);
  const currency = (code(r.currency) ?? str(r.currency_iso, r.currency_label) ?? '').toUpperCase();
  const at = iso(r.created_at ?? r.updated_at);
  if (!id || !at || !/^[A-Z]{3}$/.test(currency)) return { events: [], skipped: [{ id, reason: 'movimiento incompleto' }] };
  if (!player) return { events: [], skipped: [{ id, reason: 'jugador sin id: sincroniza jugadores antes (username sin mapear)' }] };
  if (r.status === false || r.status === 0 || r.status === '0') return { events: [], skipped: [{ id, reason: 'movimiento no confirmado por la wallet' }] };
  if (type === 'FREE_SPIN') return { events: [], skipped: [{ id, reason: 'giro gratis: la apuesta no se cobra' }] };
  if (!['DEBIT', 'CREDIT', 'ROLLBACK'].includes(type)) return { events: [], skipped: [{ id, reason: `tipo no soportado: ${type || 'vacío'}` }] };
  let amount: number;
  try { amount = Math.abs(toMinor(amountOf(r.amount), currency)); } catch (e) { return { events: [], skipped: [{ id, reason: (e as Error).message }] }; }
  const money = (n: number) => ({ amount_minor: n, currency });
  const round = str(r.round_id, r.provider_round, pick(r, 'round.id'));
  const payload = type === 'DEBIT' ? { stake: money(amount), win: money(0) } : type === 'CREDIT' ? { stake: money(0), win: money(amount) } : { stake: money(-amount), win: money(0) };
  return { events: [{ ...base(ctx, 'ss1.games', `gametx:${id}`, 'bet.settled', player, at), correlation_id: round ? `ss1:round:${round}` : `ss1:gametx:${id}`, payload: { bet_id: round ?? id, product: 'casino', ...payload } } as EventEnvelope], skipped: [] };
}

/** Fecha ISO → formato de filtro del admin (YYYY-MM-DD HH:mm:ss, UTC). */
export const ss1FilterDate = (isoDate: string) => new Date(isoDate).toISOString().slice(0, 19).replace('T', ' ');

export type TriggerOption = { key: string; label: string };
/** Catálogo de disparadores de campañas de bonos del admin → opciones para el constructor del CRM. */
export function mapTriggerCatalog(body: unknown): TriggerOption[] {
  const root = (body && typeof body === 'object' && 'data' in body ? (body as { data: unknown }).data : body) as unknown;
  const rows = Array.isArray(root) ? root : root && typeof root === 'object' ? Object.entries(root as Row).map(([key, v]) => (v && typeof v === 'object' ? { key, ...(v as Row) } : { key, label: v })) : [];
  return (rows as Row[]).map((r) => ({ key: str(r.key, r.value, r.id, r.name)!, label: str(r.label, r.name, r.title, r.key)! })).filter((x) => x.key && x.label);
}

export type SyncReport = { connector: string; fetched: number; ingested: number; duplicates: number; rejected: number; skipped: number; error?: string; samples_skipped: { id?: string; reason: string }[] };

/** Ejecuta un conector: pagina, mapea e ingiere. Los duplicados no generan efectos (idempotencia). */
export type ConnectorName = 'players' | 'financial' | 'withdrawals' | 'games';
export const CONNECTORS: ConnectorName[] = ['players', 'financial', 'withdrawals', 'games'];

/** Parámetros de consulta en el formato del admin (`filter[...]`) a partir de una fecha `since` opcional. */
export function connectorQuery(name: ConnectorName, since?: string): Record<string, string | number | undefined> {
  const from = since ? ss1FilterDate(since) : undefined;
  if (name === 'games') return { 'filter[per_page]': 500, 'filter[settlement]': 'settled', 'filter[timezone]': 'UTC', 'filter[fromDate]': from };
  if (name === 'financial') return { 'filter[per_page]': 100, 'filter[timezone]': 'UTC', 'filter[fromDate]': from };
  return { updated_since: since };
}

export async function runConnector(name: ConnectorName, client: PamSource, ingestor: Ingestor, ctx: MapContext, query: Record<string, string | number | undefined> = {}, opts: { replay?: boolean } = { replay: true }): Promise<SyncReport> {
  const rep: SyncReport = { connector: name, fetched: 0, ingested: 0, duplicates: 0, rejected: 0, skipped: 0, samples_skipped: [] };
  const map = name === 'players' ? mapPlayer : name === 'games' ? mapGameTransaction : mapFinancial;
  try {
    for await (const row of client.paginate(SS1_ENDPOINTS[name], query)) {
      rep.fetched++;
      const out = map(name === 'withdrawals' ? { type: 'withdrawal', ...row } : row, ctx);
      rep.skipped += out.skipped.length;
      if (rep.samples_skipped.length < 5) rep.samples_skipped.push(...out.skipped.slice(0, 5 - rep.samples_skipped.length));
      for (const e of out.events) {
        const r = ingestor.ingest(e, { replay: opts.replay ?? true });
        if (r.status === 'applied') rep.ingested++; else if (r.status === 'duplicate') rep.duplicates++; else rep.rejected++;
      }
    }
  } catch (e) {
    rep.error = e instanceof Ss1ApiError ? `${e.status}: ${e.message}` : (e as Error).message;
  }
  return rep;
}

/**
 * Conectores admin.syssoft1.com → eventos normalizados del CRM.
 * Los event_id son deterministas (ss1:<recurso>:<id>:<tipo>) para que una resincronización
 * sea idempotente. Los nombres de campo son tolerantes; confirmar el contrato con el equipo
 * del admin (ver docs/INTEGRATION.md · A3).
 */
import type { EventEnvelope } from '../domain/events.ts';
import type { Ingestor } from '../ingestion/ingestor.ts';
import { Ss1ApiError, type Ss1Client, toMinor } from './ss1Client.ts';

export const SS1_ENDPOINTS = {
  players: (typeof process !== 'undefined' ? process.env.SS1_PLAYERS_PATH : undefined) ?? '/admin/players',
  financial: '/admin/transactions/financial',
  withdrawals: '/admin/withdrawal-requests',
  triggerCatalog: '/admin/bonus-campaigns/trigger-catalog',
};

type Row = Record<string, unknown>;
const str = (...vs: unknown[]) => { for (const v of vs) if (v !== undefined && v !== null && v !== '') return String(v); return undefined; };
const iso = (v: unknown) => { const t = Date.parse(String(v ?? '')); return Number.isNaN(t) ? undefined : new Date(t).toISOString(); };
const pick = (r: Row, path: string) => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Row)[k] : undefined), r);

export type MapContext = { tenant_id: string; brand_id: string; country?: string; timezone?: string };
export type MapResult = { events: EventEnvelope[]; skipped: { id?: string; reason: string }[] };

const base = (ctx: MapContext, source: string, id: string, type: EventEnvelope['event_type'], player: string, at: string) =>
  ({ event_id: `ss1:${id}:${type}`, event_type: type, schema_version: 1, tenant_id: ctx.tenant_id, brand_id: ctx.brand_id, player_id: player, occurred_at: at, source, correlation_id: `ss1:${id}` }) as const;

/** Jugador → player.registered (+ player.verified si el KYC está aprobado). */
export function mapPlayer(r: Row, ctx: MapContext): MapResult {
  const id = str(r.id, r.player_id, r.uuid);
  const at = iso(r.created_at ?? r.registered_at);
  if (!id || !at) return { events: [], skipped: [{ id, reason: 'player sin id o fecha' }] };
  const email = str(r.email);
  const masked = email ? email.replace(/^(.).*(@.*)$/, '$1***$2') : 'oculto';
  const events: EventEnvelope[] = [{ ...base(ctx, 'ss1.admin', `player:${id}`, 'player.registered', id, at), payload: { email_masked: masked, country: str(r.country, r.country_code, ctx.country) ?? 'CO', locale: (str(r.locale, r.language) ?? 'es').slice(0, 2), timezone: str(r.timezone, ctx.timezone) ?? 'America/Bogota', ...(str(r.affiliate_id, pick(r, 'affiliate.id'), r.campaign_id) ? { acquisition: { campaign_id: str(r.campaign_id, r.affiliate_id, pick(r, 'affiliate.id'))!, channel: str(r.channel) ?? 'affiliate' } } : {}) } } as EventEnvelope];
  const kyc = str(r.kyc_status, pick(r, 'kyc.status'))?.toLowerCase();
  if (kyc && ['approved', 'verified', 'completed'].includes(kyc)) events.push({ ...base(ctx, 'ss1.admin', `player:${id}`, 'player.verified', id, iso(r.kyc_verified_at ?? pick(r, 'kyc.updated_at')) ?? at), payload: { kyc_status: 'verified' } } as EventEnvelope);
  return { events, skipped: [] };
}

/** Transacción financiera → deposit.settled / deposit.reversed / withdrawal.settled. */
export function mapFinancial(r: Row, ctx: MapContext): MapResult {
  const id = str(r.id, r.transaction_id, r.uuid);
  const player = str(r.player_id, pick(r, 'player.id'), r.user_id);
  const currency = (str(r.currency, r.currency_code, pick(r, 'currency.code')) ?? '').toUpperCase();
  const type = str(r.type, r.operation, r.kind)?.toLowerCase() ?? '';
  const status = str(r.status, r.state)?.toLowerCase() ?? '';
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
  return { events: [], skipped: [{ id, reason: `tipo no soportado: ${type || 'vacío'}` }] };
}

export type TriggerOption = { key: string; label: string };
/** Catálogo de disparadores de campañas de bonos del admin → opciones para el constructor del CRM. */
export function mapTriggerCatalog(body: unknown): TriggerOption[] {
  const root = (body && typeof body === 'object' && 'data' in body ? (body as { data: unknown }).data : body) as unknown;
  const rows = Array.isArray(root) ? root : root && typeof root === 'object' ? Object.entries(root as Row).map(([key, v]) => (v && typeof v === 'object' ? { key, ...(v as Row) } : { key, label: v })) : [];
  return (rows as Row[]).map((r) => ({ key: str(r.key, r.value, r.id, r.name)!, label: str(r.label, r.name, r.title, r.key)! })).filter((x) => x.key && x.label);
}

export type SyncReport = { connector: string; fetched: number; ingested: number; duplicates: number; rejected: number; skipped: number; error?: string; samples_skipped: { id?: string; reason: string }[] };

/** Ejecuta un conector: pagina, mapea e ingiere. Los duplicados no generan efectos (idempotencia). */
export async function runConnector(name: 'players' | 'financial' | 'withdrawals', client: Ss1Client, ingestor: Ingestor, ctx: MapContext, query: Record<string, string | number | undefined> = {}, opts: { replay?: boolean } = { replay: true }): Promise<SyncReport> {
  const rep: SyncReport = { connector: name, fetched: 0, ingested: 0, duplicates: 0, rejected: 0, skipped: 0, samples_skipped: [] };
  const map = name === 'players' ? mapPlayer : mapFinancial;
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

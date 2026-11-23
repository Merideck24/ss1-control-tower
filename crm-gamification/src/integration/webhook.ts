/**
 * Webhook de ingesta firmado (A4). Solo servidor (usa node:crypto).
 * Cabecera: `X-SS1-Signature: t=<unix seg>,v1=<hex HMAC-SHA256(secret, "<t>.<cuerpo crudo>")>`
 * y `X-SS1-Tenant: <tenant>` para elegir el secreto.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Ingestor } from '../ingestion/ingestor.ts';

export const MAX_BODY_BYTES = 1_000_000;
export const MAX_BATCH = 500;
export const TOLERANCE_S = 300;

export function sign(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

export type VerifyResult = { ok: true } | { ok: false; status: 400 | 401; error: string };

export function verifySignature(secret: string, header: string | undefined, rawBody: string, nowS = Math.floor(Date.now() / 1000)): VerifyResult {
  const m = /^t=(\d{9,12}),v1=([a-f0-9]{64})$/.exec(header ?? '');
  if (!m) return { ok: false, status: 401, error: 'bad_signature_header' };
  const t = Number(m[1]);
  if (Math.abs(nowS - t) > TOLERANCE_S) return { ok: false, status: 401, error: 'stale_timestamp' };
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(m[2], 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, status: 401, error: 'bad_signature' };
  return { ok: true };
}

export type WebhookOutcome = { status: number; body: unknown };

/** Procesa una entrega ya leída como texto. Eventos nuevos ⇒ modo live (con efectos). */
export function handleWebhook(opts: { secrets: Record<string, string>; tenantHeader?: string; signatureHeader?: string; rawBody: string; ingestor: Ingestor; nowS?: number }): WebhookOutcome {
  const tenant = opts.tenantHeader ?? '';
  const secret = opts.secrets[tenant];
  if (!secret) return { status: 401, body: { error: 'unknown_tenant' } };
  if (Buffer.byteLength(opts.rawBody) > MAX_BODY_BYTES) return { status: 413, body: { error: 'payload_too_large' } };
  const v = verifySignature(secret, opts.signatureHeader, opts.rawBody, opts.nowS);
  if (!v.ok) return { status: v.status, body: { error: v.error } };
  let parsed: unknown;
  try { parsed = JSON.parse(opts.rawBody); } catch { return { status: 400, body: { error: 'invalid_json' } }; }
  const events = Array.isArray((parsed as { events?: unknown })?.events) ? (parsed as { events: unknown[] }).events : [parsed];
  if (events.length > MAX_BATCH) return { status: 413, body: { error: 'batch_too_large', max: MAX_BATCH } };
  const results = events.map((e) => {
    const ev = e as { event_id?: unknown; tenant_id?: unknown };
    if (ev?.tenant_id !== tenant) return { event_id: ev?.event_id ?? null, status: 'rejected', reason: 'tenant_mismatch' };
    const r = opts.ingestor.ingest(e, { replay: false });
    return { event_id: ev.event_id ?? null, status: r.status, ...(r.reason ? { reason: r.reason } : {}) };
  });
  const count = (s: string) => results.filter((r) => r.status === s).length;
  return { status: results.every((r) => r.status === 'rejected') ? 422 : 200, body: { applied: count('applied'), duplicates: count('duplicate'), rejected: count('rejected'), results } };
}

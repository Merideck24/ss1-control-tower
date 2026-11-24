import type { EventEnvelope, EventType } from '../domain/events.ts';
import { sha256 } from '../shared/util.ts';

/**
 * B2 · Carga por lotes desde CSV (migraciones, conciliaciones, inversión de medios).
 * Cada fila se convierte en un evento normalizado con id determinista (hash del
 * contenido), así que volver a subir el mismo archivo no duplica nada. Los montos
 * llegan en unidades mayores ("12500.50") y se guardan en unidades mínimas.
 */
export const CSV_TYPES: Partial<Record<EventType, { required: string[]; optional: string[] }>> = {
  'player.registered': { required: ['player_id', 'occurred_at', 'country'], optional: ['locale', 'timezone', 'email_masked', 'campaign_id', 'channel', 'brand_id'] },
  'deposit.settled': { required: ['player_id', 'occurred_at', 'deposit_id', 'amount', 'currency'], optional: ['brand_id'] },
  'withdrawal.settled': { required: ['player_id', 'occurred_at', 'withdrawal_id', 'amount', 'currency'], optional: ['brand_id'] },
  'bet.settled': { required: ['player_id', 'occurred_at', 'bet_id', 'stake', 'currency', 'product'], optional: ['win', 'brand_id'] },
  'marketing.spend_reported': { required: ['date', 'campaign_id', 'campaign_name', 'channel', 'spend', 'currency'], optional: ['impressions', 'clicks', 'brand_id'] },
};

/** CSV RFC 4180: comillas, comillas dobles escapadas, saltos de línea dentro de comillas; separador «,» o «;». */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = []; let row: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; continue; }
    if (c === '"' && cur === '') q = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

const money = (s: string) => { const t = s.trim().replace(/\s/g, ''); if (!/^-?\d+([.,]\d{1,2})?$/.test(t)) return NaN; return Math.round(Number(t.replace(',', '.')) * 100); };

export type CsvRowError = { line: number; message: string };
export function csvToEvents(type: EventType, csv: string, ctx: { tenant_id: string; brand_id: string; source: string; max_rows?: number }): { events: EventEnvelope[]; errors: CsvRowError[]; rows: number } {
  const spec = CSV_TYPES[type];
  if (!spec) return { events: [], errors: [{ line: 0, message: `Tipo no admitido por CSV. Usa: ${Object.keys(CSV_TYPES).join(', ')}.` }], rows: 0 };
  const rows = parseCsv(csv);
  if (!rows.length) return { events: [], errors: [{ line: 0, message: 'El archivo está vacío.' }], rows: 0 };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const missing = spec.required.filter((c) => !header.includes(c));
  if (missing.length) return { events: [], errors: [{ line: 1, message: `Faltan columnas: ${missing.join(', ')}.` }], rows: rows.length - 1 };
  const max = ctx.max_rows ?? 50_000;
  if (rows.length - 1 > max) return { events: [], errors: [{ line: 0, message: `Máximo ${max} filas por archivo.` }], rows: rows.length - 1 };
  const events: EventEnvelope[] = []; const errors: CsvRowError[] = [];
  rows.slice(1).forEach((cells, idx) => {
    const line = idx + 2;
    const r: Record<string, string> = Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]));
    const fail = (m: string) => errors.push({ line, message: m });
    for (const c of spec.required) if (!r[c]) return fail(`Falta «${c}».`);
    const at = type === 'marketing.spend_reported' ? `${r.date}T00:00:00Z` : r.occurred_at;
    if (Number.isNaN(Date.parse(at)) || (type === 'marketing.spend_reported' && !/^\d{4}-\d{2}-\d{2}$/.test(r.date))) return fail('Fecha no válida (ISO 8601, p. ej. 2026-11-20T15:04:05Z; «date» como AAAA-MM-DD).');
    if (r.currency && !/^[A-Z]{3}$/.test(r.currency)) return fail('Moneda ISO de 3 letras (COP, USD…).');
    let payload: Record<string, unknown>;
    switch (type) {
      case 'player.registered':
        if (!/^[A-Z]{2}$/.test(r.country)) return fail('País ISO de 2 letras.');
        payload = { email_masked: r.email_masked || 'oculto', country: r.country, locale: (['es', 'en', 'pt'].includes(r.locale) ? r.locale : 'es'), timezone: r.timezone || 'America/Bogota', ...(r.campaign_id ? { acquisition: { campaign_id: r.campaign_id, ...(r.channel ? { channel: r.channel } : {}) } } : {}) };
        if (r.email_masked && !/\*/.test(r.email_masked)) return fail('«email_masked» debe venir enmascarado (p. ej. a***@mail.com).');
        break;
      case 'deposit.settled': case 'withdrawal.settled': {
        const a = money(r.amount); if (!(a > 0)) return fail('Monto no válido (positivo, hasta 2 decimales).');
        payload = { [type === 'deposit.settled' ? 'deposit_id' : 'withdrawal_id']: r[type === 'deposit.settled' ? 'deposit_id' : 'withdrawal_id'], amount_minor: a, currency: r.currency };
        break;
      }
      case 'bet.settled': {
        const st = money(r.stake), w = r.win ? money(r.win) : 0;
        if (!(st > 0) || !(w >= 0)) return fail('Apuesta o premio no válidos.');
        if (!['casino', 'sports'].includes(r.product)) return fail('«product» debe ser casino o sports.');
        payload = { bet_id: r.bet_id, stake: { amount_minor: st, currency: r.currency }, win: { amount_minor: w, currency: r.currency }, product: r.product };
        break;
      }
      default: {
        const sp = money(r.spend); if (!(sp >= 0)) return fail('Inversión no válida.');
        const n = (x: string) => (x ? Math.max(0, Math.round(Number(x))) : 0);
        payload = { campaign_id: r.campaign_id, campaign_name: r.campaign_name, channel: r.channel, date: r.date, impressions: n(r.impressions), clicks: n(r.clicks), spend: { amount_minor: sp, currency: r.currency } };
      }
    }
    const brand = r.brand_id || ctx.brand_id;
    const id = sha256(`${ctx.tenant_id}|${type}|${header.map((h) => r[h]).join('|')}`).slice(0, 24);
    events.push({ event_id: `csv-${id}`, event_type: type, schema_version: 1, tenant_id: ctx.tenant_id, brand_id: brand, player_id: r.player_id ?? '', occurred_at: new Date(at).toISOString(), source: ctx.source, correlation_id: `csv-${id}`, payload } as EventEnvelope);
  });
  return { events, errors, rows: rows.length - 1 };
}

import type { Channel } from '../domain/events.ts';
import type { ChannelAdapter, OutboundMessage } from './channels.ts';

/**
 * F2 · Adaptadores SMS, WhatsApp y Telegram.
 * Construyen la petición del proveedor (sin secretos: la credencial la inyecta el
 * proxy o el gateway de SS1) y la envían por un `transport` inyectable. Sin
 * transporte real configurado el envío falla de forma explícita: nunca se simula
 * como entregado. El CRM no guarda teléfonos ni chats: los resuelve SS1 al enviar.
 */
export type HttpRequest = { method: 'POST'; url: string; headers: Record<string, string>; body: string };
export type HttpResponse = { status: number; body: string };
export type Transport = (req: HttpRequest) => HttpResponse;

/** Contacto por canal, resuelto por SS1 en el momento del envío (no se almacena en el CRM). */
export type ContactResolver = (tenant: string, player: string, channel: Channel) => string | undefined;

const GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
/** Segmentos SMS: GSM-7 (160/153) o UCS-2 (70/67) si hay caracteres fuera del alfabeto. */
export function smsSegments(text: string): { encoding: 'GSM-7' | 'UCS-2'; segments: number; length: number } {
  const gsm = GSM7.test(text);
  const ext = gsm ? (text.match(/[\^{}\\[~\]|€]/g) ?? []).length : 0; // caracteres de escape cuentan doble
  const length = gsm ? text.length + ext : [...text].length;
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  return { encoding: gsm ? 'GSM-7' : 'UCS-2', length, segments: length <= single ? 1 : Math.ceil(length / multi) };
}

abstract class HttpAdapter implements ChannelAdapter {
  abstract channel: Channel;
  #transport?: Transport;
  constructor(transport?: Transport) { this.#transport = transport; }
  abstract build(msg: OutboundMessage): HttpRequest | { error: string };
  send(msg: OutboundMessage) {
    const req = this.build(msg);
    if ('error' in req) return { ok: false as const, reason: req.error, retryable: false };
    if (!this.#transport) return { ok: false as const, reason: 'provider_not_configured', retryable: false };
    let res: HttpResponse;
    try { res = this.#transport(req); } catch { return { ok: false as const, reason: 'provider_unreachable', retryable: true }; }
    if (res.status === 429 || res.status >= 500) return { ok: false as const, reason: `provider_http_${res.status}`, retryable: true };
    if (res.status >= 400) return { ok: false as const, reason: `provider_rejected_${res.status}`, retryable: false };
    return { ok: true as const, provider_message_id: this.messageId(res) ?? `${this.channel}-${msg.idempotency_key.slice(0, 12)}` };
  }
  messageId(res: HttpResponse): string | undefined { try { const j = JSON.parse(res.body); return j.sid ?? j.messages?.[0]?.id ?? (j.result?.message_id !== undefined ? String(j.result.message_id) : undefined); } catch { return undefined; } }
}

/** SMS (API tipo Twilio). Máximo 3 segmentos; sin asunto; remitente alfanumérico por marca. */
export class SmsAdapter extends HttpAdapter {
  channel: Channel = 'sms';
  #cfg: { account: string; sender: string; max_segments?: number };
  constructor(cfg: { account: string; sender: string; max_segments?: number }, transport?: Transport) { super(transport); this.#cfg = cfg; }
  build(msg: OutboundMessage): HttpRequest | { error: string } {
    const text = msg.sms_body ?? msg.body;
    const seg = smsSegments(text);
    if (seg.segments > (this.#cfg.max_segments ?? 3)) return { error: `sms_too_long:${seg.segments}_segments_${seg.encoding}` };
    if (!/^\+\d{8,15}$/.test(msg.to)) return { error: 'invalid_phone' };
    return { method: 'POST', url: `https://api.twilio.com/2010-04-01/Accounts/${this.#cfg.account}/Messages.json`, headers: { 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': msg.idempotency_key },
      body: new URLSearchParams({ To: msg.to, From: this.#cfg.sender, Body: text }).toString() };
  }
}

/** WhatsApp Cloud API. Los mensajes iniciados por la marca exigen plantilla aprobada por Meta. */
export class WhatsAppAdapter extends HttpAdapter {
  channel: Channel = 'whatsapp';
  #cfg: { phone_number_id: string; api_version?: string };
  constructor(cfg: { phone_number_id: string; api_version?: string }, transport?: Transport) { super(transport); this.#cfg = cfg; }
  build(msg: OutboundMessage): HttpRequest | { error: string } {
    if (!msg.whatsapp_template) return { error: 'whatsapp_template_not_approved' };
    if (!/^\d{8,15}$/.test(msg.to.replace(/^\+/, ''))) return { error: 'invalid_phone' };
    const params = (msg.whatsapp_params ?? []).map((text) => ({ type: 'text', text: String(text) }));
    return { method: 'POST', url: `https://graph.facebook.com/${this.#cfg.api_version ?? 'v20.0'}/${this.#cfg.phone_number_id}/messages`, headers: { 'content-type': 'application/json', 'idempotency-key': msg.idempotency_key },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: msg.to.replace(/^\+/, ''), type: 'template', template: { name: msg.whatsapp_template.name, language: { code: msg.whatsapp_template.lang }, components: params.length ? [{ type: 'body', parameters: params }] : [] } }) };
  }
}

/** Telegram Bot API (alineado con /telegram-campaigns del admin). Solo chats que el jugador vinculó. */
export class TelegramAdapter extends HttpAdapter {
  channel: Channel = 'telegram';
  #cfg: { bot: string };
  constructor(cfg: { bot: string }, transport?: Transport) { super(transport); this.#cfg = cfg; }
  build(msg: OutboundMessage): HttpRequest | { error: string } {
    if (!/^-?\d+$/.test(msg.to)) return { error: 'telegram_chat_not_linked' };
    const esc = (s: string) => s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`); // MarkdownV2
    const text = msg.subject ? `*${esc(msg.subject)}*\n${esc(msg.body)}` : esc(msg.body);
    if (text.length > 4096) return { error: 'telegram_too_long' };
    // el token del bot va en la ruta: lo completa el gateway/proxy (marcador sin secreto)
    return { method: 'POST', url: `https://api.telegram.org/bot{${this.#cfg.bot}}/sendMessage`, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: msg.to, text, parse_mode: 'MarkdownV2', disable_web_page_preview: true }) };
  }
}

/** Transporte de demostración: responde como el proveedor, sin red. Marcado como simulado en los recibos. */
export function demoTransport(channel: Channel): Transport {
  let n = 0;
  return (_req) => {
    n++;
    if (channel === 'sms') return { status: 201, body: JSON.stringify({ sid: `SMdemo${n}` }) };
    if (channel === 'whatsapp') return { status: 200, body: JSON.stringify({ messages: [{ id: `wamid.demo${n}` }] }) };
    return { status: 200, body: JSON.stringify({ ok: true, result: { message_id: n } }) };
  };
}

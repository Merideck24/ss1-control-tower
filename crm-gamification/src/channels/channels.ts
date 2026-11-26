import type { Channel, Purpose } from '../domain/events.ts';
import type { Clock } from '../shared/util.ts';
import { DomainError } from '../shared/util.ts';

export type Locale = 'es' | 'en' | 'pt';
export type Template = {
  key: string;
  category: 'transactional' | 'promotional';
  purpose: Purpose;
  content: Partial<Record<Locale, { subject?: string; body: string }>>;
  /** F2: variantes por canal. SMS: texto corto propio; WhatsApp: plantilla aprobada por Meta y sus variables. */
  channels?: { sms?: Partial<Record<Locale, string>>; whatsapp?: { name: string; lang: string; params?: string[] } };
};

export type DeliveryStatus = 'accepted' | 'failed' | 'suppressed' | 'deferred';
export type Receipt = {
  idempotency_key: string;
  tenant_id: string;
  player_id: string;
  channel: Channel;
  template: string;
  locale: Locale;
  status: DeliveryStatus;
  reason?: string;
  provider_message_id?: string;
  rendered?: { subject?: string; body: string };
  at: string;
  attempts: number;
};

export type OutboundMessage = { to: string; subject?: string; body: string; idempotency_key: string; tenant_id?: string; player_id?: string; template?: string; category?: Template['category']; sms_body?: string; whatsapp_template?: { name: string; lang: string }; whatsapp_params?: string[] };
export interface ChannelAdapter {
  channel: Channel;
  send(msg: OutboundMessage): { ok: true; provider_message_id: string } | { ok: false; reason: string; retryable: boolean };
}

/** Adaptador en memoria (simula proveedor con idempotencia y fallos inyectables). */
export class MemoryAdapter implements ChannelAdapter {
  channel: Channel;
  outbox: { to: string; subject?: string; body: string; idempotency_key: string }[] = [];
  failNext = 0;
  constructor(channel: Channel) { this.channel = channel; }
  send(msg: OutboundMessage) {
    if (this.failNext > 0) { this.failNext--; return { ok: false as const, reason: 'provider_unavailable', retryable: true }; }
    const dup = this.outbox.find((m) => m.idempotency_key === msg.idempotency_key);
    if (!dup) this.outbox.push(msg);
    return { ok: true as const, provider_message_id: `${this.channel}-${msg.idempotency_key.slice(0, 12)}` };
  }
}

export function render(t: Template, locale: Locale, vars: Record<string, string | number>) {
  const c = t.content[locale] ?? t.content.es;
  if (!c) throw new DomainError('template_missing_locale', `${t.key}:${locale}`);
  const fill = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
  return { subject: c.subject ? fill(c.subject) : undefined, body: fill(c.body) };
}

/** Variables de la plantilla (cuerpo, asunto, SMS y parámetros de WhatsApp) que no tienen valor. */
export function missingVars(t: Template, locale: Locale, channel: Channel, vars: Record<string, string | number>): string[] {
  const c = t.content[locale] ?? t.content.es;
  const texts = [c?.subject ?? '', c?.body ?? ''];
  if (channel === 'sms' && t.channels?.sms) texts.push(t.channels.sms[locale] ?? t.channels.sms.es ?? '');
  const keys = new Set(texts.flatMap((s) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])));
  if (channel === 'whatsapp') for (const k of t.channels?.whatsapp?.params ?? []) keys.add(k);
  return [...keys].filter((k) => vars[k] === undefined || vars[k] === null || String(vars[k]).trim() === '');
}

/**
 * Hub de canales: persiste la intención antes del efecto externo y usa la clave de
 * idempotencia del proveedor; un reintento con la misma clave no duplica el envío.
 */
export class ChannelHub {
  #adapters = new Map<Channel, ChannelAdapter>();
  #templates = new Map<string, Template>();
  #receipts = new Map<string, Receipt>();
  #clock: Clock;
  maxAttempts = 3;
  /** Oyente de recibos (webhooks salientes). */
  onReceipt?: (r: Receipt) => void;
  /** F2: SS1 resuelve teléfono o chat al enviar; el CRM no los almacena. */
  contacts?: (tenant: string, player: string, channel: Channel) => string | undefined;
  constructor(clock: Clock) { this.#clock = clock; }

  register(a: ChannelAdapter): void { this.#adapters.set(a.channel, a); }
  addTemplate(tenant_id: string, t: Template): void { this.#templates.set(`${tenant_id}::${t.key}`, t); }
  template(tenant_id: string, key: string): Template | undefined { return this.#templates.get(`${tenant_id}::${key}`); }
  templates(tenant_id: string): Template[] { return [...this.#templates].filter(([k]) => k.startsWith(`${tenant_id}::`)).map(([, t]) => t); }

  recordNonDelivery(base: Omit<Receipt, 'at' | 'attempts'>): Receipt {
    const r = { ...base, at: this.#clock.now().toISOString(), attempts: 0 };
    this.#receipts.set(base.idempotency_key, r);
    this.onReceipt?.(r);
    return r;
  }

  send(req: { tenant_id: string; player_id: string; address: string; channel: Channel; template: string; locale: Locale; vars: Record<string, string | number>; idempotency_key: string }): Receipt {
    const existing = this.#receipts.get(req.idempotency_key);
    if (existing && existing.status === 'accepted') return existing;
    const t = this.template(req.tenant_id, req.template);
    const base = { idempotency_key: req.idempotency_key, tenant_id: req.tenant_id, player_id: req.player_id, channel: req.channel, template: req.template, locale: req.locale };
    if (!t) return this.recordNonDelivery({ ...base, status: 'failed', reason: 'template_not_found' });
    // nunca se envía un mensaje con huecos («Llevas el % del camino al nivel .»)
    const missing = missingVars(t, req.locale, req.channel, req.vars);
    if (missing.length) return this.recordNonDelivery({ ...base, status: 'failed', reason: `template_vars_missing:${missing.join(',')}` });
    const adapter = this.#adapters.get(req.channel);
    if (!adapter) return this.recordNonDelivery({ ...base, status: 'failed', reason: 'channel_not_configured' });
    let address = req.address;
    if (req.channel === 'sms' || req.channel === 'whatsapp' || req.channel === 'telegram') {
      const c = this.contacts?.(req.tenant_id, req.player_id, req.channel);
      if (!c) return this.recordNonDelivery({ ...base, status: 'failed', reason: `no_contact_for_${req.channel}` });
      address = c;
    }
    const rendered = render(t, req.locale, req.vars);
    const fill = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => String(req.vars[k] ?? ''));
    const extra = { tenant_id: req.tenant_id, player_id: req.player_id, template: t.key, category: t.category,
      ...(t.channels?.sms ? { sms_body: fill(t.channels.sms[req.locale] ?? t.channels.sms.es ?? rendered.body) } : {}),
      ...(t.channels?.whatsapp ? { whatsapp_template: { name: t.channels.whatsapp.name, lang: t.channels.whatsapp.lang }, whatsapp_params: (t.channels.whatsapp.params ?? []).map((k) => String(req.vars[k] ?? '')) } : {}) };
    // reintentos acotados por llamada; el total acumulado queda en el recibo
    let attempts = existing?.attempts ?? 0;
    let last: ReturnType<ChannelAdapter['send']> = { ok: false, reason: 'not_attempted', retryable: true };
    for (let i = 0; i < this.maxAttempts; i++) {
      attempts++;
      last = adapter.send({ to: address, ...rendered, ...extra, idempotency_key: req.idempotency_key });
      if (last.ok || !last.retryable) break;
    }
    const r: Receipt = last.ok
      ? { ...base, status: 'accepted', provider_message_id: last.provider_message_id, rendered, at: this.#clock.now().toISOString(), attempts }
      : { ...base, status: 'failed', reason: last.reason, rendered, at: this.#clock.now().toISOString(), attempts };
    this.#receipts.set(req.idempotency_key, r);
    this.onReceipt?.(r);
    return r;
  }

  receipts(tenant_id: string, player_id?: string): Receipt[] {
    return [...this.#receipts.values()].filter((r) => r.tenant_id === tenant_id && (!player_id || r.player_id === player_id));
  }
}

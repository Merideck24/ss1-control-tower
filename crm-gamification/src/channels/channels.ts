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

/**
 * Estados de un envío según el contrato del canal (mismos significados en Control Tower, la cola de
 * fallas y los informes):
 *  · requested — el CRM registró la intención y está llamando al proveedor (escrito antes del efecto);
 *  · accepted  — el proveedor aceptó el mensaje (no garantiza que llegó);
 *  · delivered — el proveedor confirmó la entrega (callback o consulta);
 *  · failed    — el proveedor rechazó o no se pudo llamar; no hubo efecto externo;
 *  · uncertain — se llamó al proveedor y no hubo respuesta: pudo aceptarlo. Se concilia antes de reenviar;
 *  · suppressed / deferred — el CRM decidió no enviar (política) o aplazar (horario silencioso).
 */
export type DeliveryStatus = 'requested' | 'accepted' | 'delivered' | 'failed' | 'uncertain' | 'suppressed' | 'deferred';
export const DELIVERY_STATUSES: DeliveryStatus[] = ['requested', 'accepted', 'delivered', 'failed', 'uncertain', 'suppressed', 'deferred'];
/** Aceptado o entregado: el mensaje salió del CRM hacia el jugador. */
export const isSent = (s: DeliveryStatus) => s === 'accepted' || s === 'delivered';
/** Origen del envío dentro de un recorrido: permite reprocesar con la versión fijada. */
export type ReceiptOrigin = { journey_id: string; version: number; instance_id: string; node_id: string; purpose: Purpose; trigger_event_id?: string };
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
  /** Para reenviar con la misma clave: dirección enmascarada y variables de la plantilla. */
  address?: string;
  vars?: Record<string, string | number>;
  origin?: ReceiptOrigin;
  /** Fecha de la última respuesta del proveedor (aceptación o entrega). */
  provider_at?: string;
};

export type OutboundMessage = { to: string; subject?: string; body: string; idempotency_key: string; tenant_id?: string; player_id?: string; template?: string; category?: Template['category']; sms_body?: string; whatsapp_template?: { name: string; lang: string }; whatsapp_params?: string[] };
export interface ChannelAdapter {
  channel: Channel;
  send(msg: OutboundMessage): { ok: true; provider_message_id: string } | { ok: false; reason: string; retryable: boolean; uncertain?: boolean };
  /** Conciliación: ¿el proveedor tiene un mensaje con esta clave? (para resolver un envío incierto). */
  lookup?(idempotency_key: string): { found: true; provider_message_id: string } | { found: false } | { unavailable: true };
}

/** Adaptador en memoria (simula proveedor con idempotencia y fallos inyectables). */
export class MemoryAdapter implements ChannelAdapter {
  channel: Channel;
  outbox: { to: string; subject?: string; body: string; idempotency_key: string }[] = [];
  failNext = 0;
  /** Simula un tiempo de espera agotado DESPUÉS de que el proveedor aceptó (o no) el mensaje. */
  timeoutNext: 'accepted' | 'lost' | null = null;
  /** Errores no recuperables inyectables (p. ej. dirección rechazada). */
  rejectNext: string | null = null;
  lookupAvailable = true;
  constructor(channel: Channel) { this.channel = channel; }
  send(msg: OutboundMessage) {
    if (this.timeoutNext) {
      if (this.timeoutNext === 'accepted' && !this.outbox.some((m) => m.idempotency_key === msg.idempotency_key)) this.outbox.push(msg);
      this.timeoutNext = null;
      return { ok: false as const, reason: 'provider_timeout', retryable: false, uncertain: true };
    }
    if (this.rejectNext) { const reason = this.rejectNext; this.rejectNext = null; return { ok: false as const, reason, retryable: false }; }
    if (this.failNext > 0) { this.failNext--; return { ok: false as const, reason: 'provider_unavailable', retryable: true }; }
    const dup = this.outbox.find((m) => m.idempotency_key === msg.idempotency_key);
    if (!dup) this.outbox.push(msg);
    return { ok: true as const, provider_message_id: `${this.channel}-${msg.idempotency_key.slice(0, 12)}` };
  }
  lookup(key: string) {
    if (!this.lookupAvailable) return { unavailable: true as const };
    return this.outbox.some((m) => m.idempotency_key === key) ? { found: true as const, provider_message_id: `${this.channel}-${key.slice(0, 12)}` } : { found: false as const };
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
export type SendRequest = { tenant_id: string; player_id: string; address: string; channel: Channel; template: string; locale: Locale; vars: Record<string, string | number>; idempotency_key: string; origin?: ReceiptOrigin };

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
    const prev = this.#receipts.get(base.idempotency_key);
    const r = { ...base, at: this.#clock.now().toISOString(), attempts: prev?.attempts ?? 0 };
    this.#put(r);
    return r;
  }

  send(req: SendRequest, opts: { afterReconcile?: boolean } = {}): Receipt {
    const existing = this.#receipts.get(req.idempotency_key);
    if (existing && isSent(existing.status)) return existing;
    // un envío incierto nunca se repite a ciegas: primero se concilia con el proveedor
    if (existing && (existing.status === 'uncertain' || existing.status === 'requested') && !opts.afterReconcile) return existing;
    const t = this.template(req.tenant_id, req.template);
    const base = { idempotency_key: req.idempotency_key, tenant_id: req.tenant_id, player_id: req.player_id, channel: req.channel, template: req.template, locale: req.locale, address: req.address, vars: req.vars, ...(req.origin ? { origin: req.origin } : {}) };
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
    // escritura previa al efecto: si el proceso cae durante la llamada, queda «requested» y se concilia
    this.#put({ ...base, status: 'requested', rendered, at: this.#clock.now().toISOString(), attempts });
    let last: ReturnType<ChannelAdapter['send']> = { ok: false, reason: 'not_attempted', retryable: true };
    for (let i = 0; i < this.maxAttempts; i++) {
      attempts++;
      try {
        last = adapter.send({ to: address, ...rendered, ...extra, idempotency_key: req.idempotency_key });
      } catch (e) {
        // excepción durante la llamada: no sabemos si el proveedor lo recibió
        last = { ok: false, reason: `provider_error:${(e as Error).name}`, retryable: false, uncertain: true };
      }
      if (last.ok || !last.retryable) break;
    }
    const now = this.#clock.now().toISOString();
    const r: Receipt = last.ok
      ? { ...base, status: 'accepted', provider_message_id: last.provider_message_id, rendered, at: now, provider_at: now, attempts }
      : { ...base, status: last.uncertain ? 'uncertain' : 'failed', reason: last.reason, rendered, at: now, attempts };
    this.#put(r);
    return r;
  }

  #put(r: Receipt): void {
    this.#receipts.set(r.idempotency_key, r);
    this.onReceipt?.(r);
  }

  receipt(tenant_id: string, key: string): Receipt | undefined {
    const r = this.#receipts.get(key);
    return r && r.tenant_id === tenant_id ? r : undefined;
  }

  /** Conciliación de un envío incierto: pregunta al proveedor si tiene el mensaje. */
  reconcile(tenant_id: string, key: string): 'accepted' | 'not_found' | 'unavailable' {
    const r = this.receipt(tenant_id, key);
    if (!r) return 'not_found';
    const lookup = this.#adapters.get(r.channel)?.lookup?.(key);
    if (!lookup || 'unavailable' in lookup) return 'unavailable';
    if (lookup.found) { this.#put({ ...r, status: 'accepted', reason: undefined, provider_message_id: lookup.provider_message_id, provider_at: this.#clock.now().toISOString(), at: this.#clock.now().toISOString() }); return 'accepted'; }
    return 'not_found';
  }

  /** Callback del proveedor: entrega confirmada. */
  markDelivered(tenant_id: string, key: string, at = this.#clock.now().toISOString()): Receipt | undefined {
    const r = this.receipt(tenant_id, key);
    if (!r || !isSent(r.status)) return r;
    const next = { ...r, status: 'delivered' as const, provider_at: at };
    this.#put(next);
    return next;
  }

  /** Vuelve a cargar recibos guardados (reinicio con PostgreSQL) sin emitir efectos ni webhooks. */
  restore(rs: Receipt[]): void {
    for (const r of rs) {
      const prev = this.#receipts.get(r.idempotency_key);
      if (prev && Date.parse(prev.at) > Date.parse(r.at)) continue; // no pisar un estado local más nuevo
      this.#receipts.set(r.idempotency_key, r);
    }
  }

  receipts(tenant_id: string, player_id?: string): Receipt[] {
    return [...this.#receipts.values()].filter((r) => r.tenant_id === tenant_id && (!player_id || r.player_id === player_id));
  }
}

import type { Channel, Purpose } from '../domain/events.ts';
import type { Clock } from '../shared/util.ts';
import { DomainError } from '../shared/util.ts';

export type Locale = 'es' | 'en' | 'pt';
export type Template = {
  key: string;
  category: 'transactional' | 'promotional';
  purpose: Purpose;
  content: Partial<Record<Locale, { subject?: string; body: string }>>;
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

export interface ChannelAdapter {
  channel: Channel;
  send(msg: { to: string; subject?: string; body: string; idempotency_key: string }): { ok: true; provider_message_id: string } | { ok: false; reason: string; retryable: boolean };
}

/** Adaptador en memoria (simula proveedor con idempotencia y fallos inyectables). */
export class MemoryAdapter implements ChannelAdapter {
  channel: Channel;
  outbox: { to: string; subject?: string; body: string; idempotency_key: string }[] = [];
  failNext = 0;
  constructor(channel: Channel) { this.channel = channel; }
  send(msg: { to: string; subject?: string; body: string; idempotency_key: string }) {
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
  constructor(clock: Clock) { this.#clock = clock; }

  register(a: ChannelAdapter): void { this.#adapters.set(a.channel, a); }
  addTemplate(tenant_id: string, t: Template): void { this.#templates.set(`${tenant_id}::${t.key}`, t); }
  template(tenant_id: string, key: string): Template | undefined { return this.#templates.get(`${tenant_id}::${key}`); }
  templates(tenant_id: string): Template[] { return [...this.#templates].filter(([k]) => k.startsWith(`${tenant_id}::`)).map(([, t]) => t); }

  recordNonDelivery(base: Omit<Receipt, 'at' | 'attempts'>): Receipt {
    const r = { ...base, at: this.#clock.now().toISOString(), attempts: 0 };
    this.#receipts.set(base.idempotency_key, r);
    return r;
  }

  send(req: { tenant_id: string; player_id: string; address: string; channel: Channel; template: string; locale: Locale; vars: Record<string, string | number>; idempotency_key: string }): Receipt {
    const existing = this.#receipts.get(req.idempotency_key);
    if (existing && existing.status === 'accepted') return existing;
    const t = this.template(req.tenant_id, req.template);
    const base = { idempotency_key: req.idempotency_key, tenant_id: req.tenant_id, player_id: req.player_id, channel: req.channel, template: req.template, locale: req.locale };
    if (!t) return this.recordNonDelivery({ ...base, status: 'failed', reason: 'template_not_found' });
    const adapter = this.#adapters.get(req.channel);
    if (!adapter) return this.recordNonDelivery({ ...base, status: 'failed', reason: 'channel_not_configured' });
    const rendered = render(t, req.locale, req.vars);
    // reintentos acotados por llamada; el total acumulado queda en el recibo
    let attempts = existing?.attempts ?? 0;
    let last: ReturnType<ChannelAdapter['send']> = { ok: false, reason: 'not_attempted', retryable: true };
    for (let i = 0; i < this.maxAttempts; i++) {
      attempts++;
      last = adapter.send({ to: req.address, ...rendered, idempotency_key: req.idempotency_key });
      if (last.ok || !last.retryable) break;
    }
    const r: Receipt = last.ok
      ? { ...base, status: 'accepted', provider_message_id: last.provider_message_id, rendered, at: this.#clock.now().toISOString(), attempts }
      : { ...base, status: 'failed', reason: last.reason, rendered, at: this.#clock.now().toISOString(), attempts };
    this.#receipts.set(req.idempotency_key, r);
    return r;
  }

  receipts(tenant_id: string, player_id?: string): Receipt[] {
    return [...this.#receipts.values()].filter((r) => r.tenant_id === tenant_id && (!player_id || r.player_id === player_id));
  }
}

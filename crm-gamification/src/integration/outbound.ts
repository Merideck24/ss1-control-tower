import type { AuditLog } from '../audit/audit.ts';
import { DomainError, hmacSha256, sha256, type Clock } from '../shared/util.ts';
import type { EventBus } from './bus.ts';

/**
 * J2 · Webhooks salientes firmados: el CRM avisa a sistemas de SS1 (o de terceros
 * autorizados) cuando decide o entrega algo. Firma HMAC-SHA256 con el mismo esquema
 * que la ingesta (`t=<seg>,v1=<hex>` sobre "<t>.<cuerpo>"), entrega al menos una vez
 * con id estable para deduplicar, reintentos con espera creciente, cola de muertos y
 * desactivación automática tras fallos seguidos. Sin datos personales en el cuerpo.
 */
export const WEBHOOK_EVENTS = [
  'delivery.accepted', 'delivery.failed', 'delivery.suppressed', 'reward.confirmed', 'reward.failed',
  'rg.case_opened', 'rg.case_closed', 'abuse.reviewed', 'policy.approved', 'content.approved', 'onsite.approved',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export type HttpRequest = { url: string; headers: Record<string, string>; body: string };
export type Transport = (req: HttpRequest) => Promise<{ status: number }>;

export type Subscription = { id: string; tenant_id: string; url: string; events: WebhookEvent[]; description: string; status: 'active' | 'paused' | 'disabled'; secret: string; created_by: string; created_at: string; consecutive_failures: number };
export type Delivery = { id: string; tenant_id: string; subscription_id: string; event: WebhookEvent; body: string; attempts: number; status: 'pending' | 'delivered' | 'failed' | 'dead'; next_at: number; last_status?: number; last_error?: string; created_at: string; delivered_at?: string };

export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
const DISABLE_AFTER = 20;

/** Solo https públicos: nada de localhost, IPs privadas ni dominios internos (evita SSRF). */
export function validateWebhookUrl(u: string): string | null {
  let x: URL; try { x = new URL(u); } catch { return 'URL no válida.'; }
  if (x.protocol !== 'https:') return 'Solo se admiten URLs https.';
  if (x.username || x.password) return 'La URL no puede llevar usuario ni contraseña.';
  const h = x.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost') || !h.includes('.')) return 'No se permiten destinos internos.';
  if (/^(\d+\.){3}\d+$/.test(h) || h.includes(':')) return 'Usa un nombre de dominio, no una IP.';
  return null;
}

const randomSecret = () => { const b = new Uint8Array(24); globalThis.crypto.getRandomValues(b); return 'whsec_' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); };

export class OutboundWebhooks {
  #subs = new Map<string, Subscription>();
  #deliveries = new Map<string, Delivery>();
  #audit: AuditLog; #clock: Clock; #transport?: Transport; #bus?: EventBus;
  #seq = 0;
  constructor(deps: { audit: AuditLog; clock: Clock; transport?: Transport; bus?: EventBus }) { this.#audit = deps.audit; this.#clock = deps.clock; this.#transport = deps.transport; this.#bus = deps.bus; }
  setTransport(t: Transport) { this.#transport = t; }

  list(tenant: string) { return [...this.#subs.values()].filter((s) => s.tenant_id === tenant).map(({ secret: _s, ...rest }) => ({ ...rest, secret_hint: `${_s.slice(0, 10)}…` })); }
  deliveries(tenant: string, subscription?: string) { return [...this.#deliveries.values()].filter((d) => d.tenant_id === tenant && (!subscription || d.subscription_id === subscription)).sort((a, b) => b.created_at.localeCompare(a.created_at)); }
  #sub(tenant: string, id: string) { const s = this.#subs.get(id); if (!s || s.tenant_id !== tenant) throw new DomainError('not_found', `No existe la suscripción ${id}.`); return s; }

  /** Crea la suscripción; el secreto se muestra una sola vez. */
  create(actor: { id: string; tenant_id: string }, input: { url: string; events: string[]; description?: string }) {
    const bad = validateWebhookUrl(String(input.url ?? ''));
    if (bad) throw new DomainError('invalid_url', bad);
    const evs = [...new Set(input.events ?? [])];
    if (!evs.length || evs.some((e) => !WEBHOOK_EVENTS.includes(e as WebhookEvent))) throw new DomainError('invalid_events', `Elige eventos de: ${WEBHOOK_EVENTS.join(', ')}.`);
    if (this.list(actor.tenant_id).length >= 10) throw new DomainError('limit', 'Máximo 10 suscripciones por tenant.');
    const now = this.#clock.now().toISOString();
    const s: Subscription = { id: `wh_${sha256(`${actor.tenant_id}:${input.url}:${now}:${++this.#seq}`).slice(0, 10)}`, tenant_id: actor.tenant_id, url: input.url, events: evs as WebhookEvent[], description: String(input.description ?? '').slice(0, 120), status: 'active', secret: randomSecret(), created_by: actor.id, created_at: now, consecutive_failures: 0 };
    this.#subs.set(s.id, s);
    this.#audit.record(actor.tenant_id, actor.id, 'webhook.created', s.id, { host: new URL(s.url).hostname, events: s.events });
    return { ...this.list(actor.tenant_id).find((x) => x.id === s.id)!, secret: s.secret, note: 'Guarda el secreto ahora: no se vuelve a mostrar.' };
  }
  setStatus(actor: { id: string; tenant_id: string }, id: string, status: 'active' | 'paused') {
    const s = this.#sub(actor.tenant_id, id); s.status = status; if (status === 'active') s.consecutive_failures = 0;
    this.#audit.record(actor.tenant_id, actor.id, `webhook.${status === 'active' ? 'resumed' : 'paused'}`, id, {});
    return this.list(actor.tenant_id).find((x) => x.id === id)!;
  }
  rotate(actor: { id: string; tenant_id: string }, id: string) {
    const s = this.#sub(actor.tenant_id, id); s.secret = randomSecret();
    this.#audit.record(actor.tenant_id, actor.id, 'webhook.secret_rotated', id, {});
    return { id, secret: s.secret, note: 'Secreto nuevo: las entregas siguientes se firman con él.' };
  }

  /** Encola el evento para cada suscripción activa interesada y lo publica en el bus. */
  emit(tenant: string, event: WebhookEvent, data: Record<string, unknown>) {
    const now = this.#clock.now();
    const payload = { type: event, tenant_id: tenant, created_at: now.toISOString(), data };
    this.#bus?.publish(`crm.outbound.${tenant}`, payload);
    for (const s of this.#subs.values()) {
      if (s.tenant_id !== tenant || s.status !== 'active' || !s.events.includes(event)) continue;
      const id = `whd_${sha256(`${s.id}:${event}:${JSON.stringify(data)}:${++this.#seq}`).slice(0, 16)}`;
      this.#deliveries.set(id, { id, tenant_id: tenant, subscription_id: s.id, event, body: JSON.stringify({ id, ...payload }), attempts: 0, status: 'pending', next_at: now.getTime(), created_at: now.toISOString() });
    }
  }

  /** Envía lo vencido. Lo llama un programador (servidor cada 10 s; demo en el navegador). */
  async dispatch(limit = 100): Promise<{ sent: number; delivered: number; retried: number; dead: number }> {
    const out = { sent: 0, delivered: 0, retried: 0, dead: 0 };
    if (!this.#transport) return out;
    const now = this.#clock.now().getTime();
    const due = [...this.#deliveries.values()].filter((d) => d.status === 'pending' && d.next_at <= now).sort((a, b) => a.next_at - b.next_at).slice(0, limit);
    for (const d of due) {
      const s = this.#subs.get(d.subscription_id);
      if (!s || s.status !== 'active') continue;
      const t = Math.floor(now / 1000);
      const req: HttpRequest = { url: s.url, body: d.body, headers: { 'content-type': 'application/json', 'user-agent': 'SS1-CRM-Webhooks/1', 'x-ss1-crm-event': d.event, 'x-ss1-crm-delivery': d.id, 'x-ss1-crm-signature': `t=${t},v1=${hmacSha256(s.secret, `${t}.${d.body}`)}` } };
      d.attempts++; out.sent++;
      let status = 0;
      try { status = (await this.#transport(req)).status; } catch (e) { d.last_error = (e as Error).message.slice(0, 120); }
      d.last_status = status;
      if (status >= 200 && status < 300) { d.status = 'delivered'; d.delivered_at = new Date(now).toISOString(); s.consecutive_failures = 0; out.delivered++; continue; }
      s.consecutive_failures++;
      const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (permanent) d.status = 'failed';
      else if (d.attempts >= MAX_ATTEMPTS) { d.status = 'dead'; out.dead++; }
      else { d.next_at = now + BACKOFF_MS[d.attempts - 1]; out.retried++; }
      if (s.consecutive_failures >= DISABLE_AFTER && s.status === 'active') {
        s.status = 'disabled';
        this.#audit.record(s.tenant_id, 'system', 'webhook.auto_disabled', s.id, { failures: s.consecutive_failures });
      }
    }
    return out;
  }
  retry(actor: { id: string; tenant_id: string }, deliveryId: string) {
    const d = this.#deliveries.get(deliveryId);
    if (!d || d.tenant_id !== actor.tenant_id) throw new DomainError('not_found', 'No existe la entrega.');
    if (d.status === 'delivered' || d.status === 'pending') throw new DomainError('invalid_state', 'Solo se reintentan entregas fallidas o muertas.');
    d.status = 'pending'; d.next_at = this.#clock.now().getTime(); d.attempts = 0;
    this.#audit.record(actor.tenant_id, actor.id, 'webhook.retry', deliveryId, {});
    return d;
  }
}

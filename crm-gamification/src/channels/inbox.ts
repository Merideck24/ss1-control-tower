import type { Channel } from '../domain/events.ts';
import { DAY, DomainError, type Clock } from '../shared/util.ts';
import type { ChannelAdapter, OutboundMessage } from './channels.ts';

/**
 * F4 · Centro de notificaciones del jugador.
 * El canal in-app entrega a una bandeja persistente: leído / no leído, vigencia,
 * archivado y categoría (servicio o promoción). Idempotente por clave de envío.
 */
export type InboxItem = {
  id: string; tenant_id: string; player_id: string; template: string; category: 'transactional' | 'promotional';
  title: string; body: string; created_at: string; expires_at: string; read_at?: string; archived_at?: string;
};

export class InboxAdapter implements ChannelAdapter {
  channel: Channel = 'inapp';
  #items = new Map<string, InboxItem>(); // id = idempotency key
  #clock: Clock;
  /** Vigencia por categoría: promociones caducan antes que avisos de servicio. */
  ttlDays = { promotional: 14, transactional: 60 };
  /** Compatibilidad con el adaptador en memoria (pruebas e informes existentes). */
  get outbox() { return [...this.#items.values()].map((i) => ({ to: i.player_id, subject: i.title, body: i.body, idempotency_key: i.id })); }
  failNext = 0;
  constructor(clock: Clock) { this.#clock = clock; }

  send(msg: OutboundMessage) {
    if (this.failNext > 0) { this.failNext--; return { ok: false as const, reason: 'provider_unavailable', retryable: true }; }
    if (!msg.tenant_id || !msg.player_id) return { ok: false as const, reason: 'inbox_requires_player', retryable: false };
    if (!this.#items.has(msg.idempotency_key)) {
      const now = this.#clock.now();
      const category = msg.category ?? 'promotional';
      this.#items.set(msg.idempotency_key, { id: msg.idempotency_key, tenant_id: msg.tenant_id, player_id: msg.player_id, template: msg.template ?? '', category,
        title: msg.subject ?? '', body: msg.body, created_at: now.toISOString(), expires_at: new Date(now.getTime() + this.ttlDays[category] * DAY).toISOString() });
    }
    return { ok: true as const, provider_message_id: `inbox-${msg.idempotency_key.slice(0, 12)}` };
  }

  /** Bandeja visible: sin vencidos ni archivados, más recientes primero. */
  list(tenant: string, player: string, opts: { include_archived?: boolean } = {}) {
    const now = this.#clock.now().toISOString();
    const items = [...this.#items.values()].filter((i) => i.tenant_id === tenant && i.player_id === player && i.expires_at > now && (opts.include_archived || !i.archived_at))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    return { unread: items.filter((i) => !i.read_at && !i.archived_at).length, items };
  }
  #own(tenant: string, player: string, id: string) {
    const i = this.#items.get(id);
    if (!i || i.tenant_id !== tenant || i.player_id !== player) throw new DomainError('not_found', 'El mensaje no existe en esta bandeja.');
    return i;
  }
  markRead(tenant: string, player: string, id: string) { const i = this.#own(tenant, player, id); i.read_at ??= this.#clock.now().toISOString(); return i; }
  markAllRead(tenant: string, player: string) { let n = 0; for (const i of this.list(tenant, player).items) if (!i.read_at) { i.read_at = this.#clock.now().toISOString(); n++; } return { marked: n }; }
  archive(tenant: string, player: string, id: string) { const i = this.#own(tenant, player, id); i.archived_at ??= this.#clock.now().toISOString(); i.read_at ??= i.archived_at; return i; }
  /** Métricas agregadas para la Control Tower: aperturas sobre entregados. */
  stats(tenant: string) {
    const all = [...this.#items.values()].filter((i) => i.tenant_id === tenant);
    return { delivered: all.length, read: all.filter((i) => i.read_at).length, archived: all.filter((i) => i.archived_at).length };
  }
}

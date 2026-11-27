import type { AuditLog } from '../audit/audit.ts';
import { SCOPES, type Scope } from '../api/catalog.ts';
import { DomainError, safeEqual, sha256, type Clock } from '../shared/util.ts';

/**
 * Llaves de servicio (máquina a máquina) para que sistemas de SS1 —PAM, sitio, cajero,
 * backoffice— llamen a la API del CRM sin un usuario humano.
 * Formato: `ss1crm_<key_id>_<secreto>`. Solo se guarda el hash; el valor se muestra una vez.
 * Cada llave tiene alcances (scopes); la ruta pedida debe declarar uno de ellos en el
 * catálogo y, si la ruta exige un permiso de rol, ese permiso debe estar cubierto por un
 * alcance de la llave (las aprobaciones nunca lo están).
 */
export const PERM_SCOPES: Record<string, Scope[]> = {
  'players.read': ['players:read', 'onsite:serve'],
  'player.preferences': ['players:write'],
  'gamification.player': ['players:write'],
  'events.write': ['events:write'],
  'ingest.csv': ['events:write'],
  'analytics.read': ['analytics:read'],
  'performance.read': ['analytics:read'],
  'alerts.read': ['analytics:read'],
  'onsite.read': ['analytics:read'],
  'segments.preview': ['segments:read', 'analytics:read'],
  'gamification.read': ['journeys:read'],
  'rg.monitor': ['rg:read'],
  'abuse.read': ['abuse:read'],
  'policy.read': ['policies:read'],
  'audit.read': ['audit:read'],
  'integration.read': ['webhooks:manage'],
  'integration.sync': ['webhooks:manage'],
};

export type ServiceKey = { key_id: string; tenant_id: string; name: string; scopes: Scope[]; key_hash: string; created_by: string; created_at: string; last_used_at?: string; revoked_at?: string };
export type ServiceActor = { id: string; tenant_id: string; roles: []; scopes: Scope[]; key_id: string };

const rand = (n: number) => { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); };

export class ServiceKeys {
  #keys = new Map<string, ServiceKey>();
  #audit: AuditLog; #clock: Clock;
  constructor(deps: { audit: AuditLog; clock: Clock }) { this.#audit = deps.audit; this.#clock = deps.clock; }

  list(tenant: string) { return [...this.#keys.values()].filter((k) => k.tenant_id === tenant).map(({ key_hash: _h, ...k }) => k); }

  create(actor: { id: string; tenant_id: string }, input: { name?: string; scopes?: string[] }) {
    const name = String(input.name ?? '').trim();
    if (!/^[\w .-]{3,60}$/.test(name)) throw new DomainError('invalid_name', 'Nombre de 3 a 60 caracteres (p. ej. «PAM producción»).');
    const scopes = [...new Set(input.scopes ?? [])];
    if (!scopes.length || scopes.some((s) => !(s in SCOPES))) throw new DomainError('invalid_scopes', `Alcances válidos: ${Object.keys(SCOPES).join(', ')}.`);
    if (this.list(actor.tenant_id).filter((k) => !k.revoked_at).length >= 20) throw new DomainError('limit', 'Máximo 20 llaves activas por tenant.');
    const key_id = rand(6), secret = rand(24);
    const value = `ss1crm_${key_id}_${secret}`;
    const k: ServiceKey = { key_id, tenant_id: actor.tenant_id, name, scopes: scopes as Scope[], key_hash: sha256(value), created_by: actor.id, created_at: this.#clock.now().toISOString() };
    this.#keys.set(key_id, k);
    this.#audit.record(actor.tenant_id, actor.id, 'service_key.created', key_id, { name, scopes });
    return { ...this.list(actor.tenant_id).find((x) => x.key_id === key_id)!, key: value, note: 'Guarda la llave ahora: no se vuelve a mostrar. Envíala como «Authorization: Bearer <llave>».' };
  }

  revoke(actor: { id: string; tenant_id: string }, keyId: string) {
    const k = this.#keys.get(keyId);
    if (!k || k.tenant_id !== actor.tenant_id) throw new DomainError('not_found', 'No existe la llave.');
    k.revoked_at ??= this.#clock.now().toISOString();
    this.#audit.record(actor.tenant_id, actor.id, 'service_key.revoked', keyId, {});
    return this.list(actor.tenant_id).find((x) => x.key_id === keyId)!;
  }

  /** Valida el valor presentado. Comparación en tiempo constante; nunca revela si existe el id. */
  authenticate(value: string): ServiceActor | null {
    const m = /^ss1crm_([0-9a-f]{12})_([0-9a-f]{48})$/.exec(value);
    if (!m) return null;
    const k = this.#keys.get(m[1]);
    if (!k || k.revoked_at || !safeEqual(k.key_hash, sha256(value))) return null;
    k.last_used_at = this.#clock.now().toISOString();
    return { id: `svc:${k.name}`, tenant_id: k.tenant_id, roles: [], scopes: k.scopes, key_id: k.key_id };
  }
}

/** Límite por llave: cubeta de fichas (por defecto 600 peticiones por minuto). */
export class RateLimiter {
  #b = new Map<string, { tokens: number; at: number }>();
  perMinute: number;
  constructor(perMinute = 600) { this.perMinute = perMinute; }
  take(key: string, now = Date.now()): { ok: boolean; retry_after_s: number } {
    const cap = this.perMinute, rate = cap / 60_000;
    const s = this.#b.get(key) ?? { tokens: cap, at: now };
    s.tokens = Math.min(cap, s.tokens + (now - s.at) * rate); s.at = now;
    if (s.tokens < 1) { this.#b.set(key, s); return { ok: false, retry_after_s: Math.ceil((1 - s.tokens) / rate / 1000) }; }
    s.tokens -= 1; this.#b.set(key, s);
    return { ok: true, retry_after_s: 0 };
  }
}

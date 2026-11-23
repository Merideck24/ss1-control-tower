/**
 * Identidad SS1 en el servidor (A2): valida el token del admin contra api.syssoft1.com,
 * obtiene usuario, operador y permisos CASL, y decide los roles del CRM. El navegador
 * nunca decide roles en producción.
 *
 * Supuesto a confirmar con el equipo del admin: `GET /admin/bootstrap` con el Bearer del
 * usuario devuelve el usuario, su operador (client) y sus reglas CASL. La ruta y la
 * extracción son configurables; el extractor acepta las formas habituales.
 */
import type { Actor, Role } from '../journeys/registry.ts';
import { sha256 } from '../shared/util.ts';
import { abilitiesToRoles, type CaslRule } from './ss1Auth.ts';

export type IdentityResult = { ok: true; actor: Actor } | { ok: false; status: 401 | 403 | 502; error: string };

export type Ss1IdentityOptions = {
  apiBase: string;
  profilePath?: string;
  /** client id/slug del admin → tenant del CRM. Sin entrada se usa el slug tal cual. */
  tenantMap?: Record<string, string>;
  cacheTtlMs?: number;
  negativeTtlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

type Profile = { userId: string; name?: string; client?: string; rules: CaslRule[] };

/** Extrae usuario, operador y reglas CASL de respuestas con formas comunes. */
export function extractProfile(body: unknown): Profile | null {
  const root = (body && typeof body === 'object' && 'data' in body ? (body as { data: unknown }).data : body) as Record<string, unknown> | null;
  if (!root || typeof root !== 'object') return null;
  const user = (root.user ?? root.me ?? root.profile ?? root) as Record<string, unknown>;
  const id = user?.id ?? user?.user_id;
  if (id === undefined || id === null) return null;
  const rulesRaw = (root.abilities ?? root.ability_rules ?? root.ability ?? root.permissions ?? user.abilities ?? user.ability_rules ?? []) as unknown[];
  const rules: CaslRule[] = Array.isArray(rulesRaw)
    ? rulesRaw.flatMap((r) => {
        if (r && typeof r === 'object' && 'action' in r && 'subject' in r) return [r as CaslRule];
        if (typeof r === 'string' && r.includes('.')) { const [subject, action] = r.split('.'); return [{ subject, action }]; } // "crm.read"
        return [];
      })
    : [];
  const client = (root.client ?? user.client) as Record<string, unknown> | undefined;
  const clientKey = client?.slug ?? client?.id ?? user.client_id ?? root.client_id;
  return { userId: String(id), name: typeof user.name === 'string' ? user.name : undefined, client: clientKey === undefined || clientKey === null ? undefined : String(clientKey), rules };
}

export class Ss1IdentityProvider {
  #o: Required<Omit<Ss1IdentityOptions, 'tenantMap'>> & { tenantMap: Record<string, string> };
  #cache = new Map<string, { until: number; profile: Profile | null }>();
  calls = 0;
  constructor(o: Ss1IdentityOptions) {
    this.#o = { profilePath: '/admin/bootstrap', tenantMap: {}, cacheTtlMs: 60_000, negativeTtlMs: 10_000, fetchImpl: fetch, now: () => Date.now(), ...o };
  }

  async #profile(token: string): Promise<Profile | null | 'upstream_error'> {
    const key = sha256(token); // nunca se guarda ni registra el token en claro
    const hit = this.#cache.get(key);
    if (hit && hit.until > this.#o.now()) return hit.profile;
    this.calls++;
    let res: Response;
    try {
      res = await this.#o.fetchImpl(this.#o.apiBase + this.#o.profilePath, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    } catch { return 'upstream_error'; }
    if (res.status === 401 || res.status === 403) { this.#cache.set(key, { until: this.#o.now() + this.#o.negativeTtlMs, profile: null }); return null; }
    if (!res.ok) return 'upstream_error';
    const profile = extractProfile(await res.json().catch(() => null));
    this.#cache.set(key, { until: this.#o.now() + (profile ? this.#o.cacheTtlMs : this.#o.negativeTtlMs), profile });
    return profile;
  }

  async resolve(authorization: string | undefined, requestedTenant: string | undefined): Promise<IdentityResult> {
    const m = /^Bearer\s+(\S{10,4096})$/i.exec(authorization ?? '');
    if (!m) return { ok: false, status: 401, error: 'missing_token' };
    const p = await this.#profile(m[1]);
    if (p === 'upstream_error') return { ok: false, status: 502, error: 'identity_unavailable' };
    if (!p) return { ok: false, status: 401, error: 'invalid_token' };
    const tenant = p.client ? this.#o.tenantMap[p.client] ?? p.client : undefined;
    if (!tenant) return { ok: false, status: 403, error: 'no_tenant' };
    if (requestedTenant && requestedTenant !== tenant) return { ok: false, status: 403, error: 'tenant_mismatch' };
    const roles: Role[] = abilitiesToRoles(p.rules);
    return { ok: true, actor: { id: `ss1:${p.userId}`, tenant_id: tenant, roles } };
  }
}

/**
 * Cliente de la API de admin.syssoft1.com (Laravel). Usa el token del usuario del admin
 * (delegado) o un token de servicio. Tiempo límite, reintentos con espera creciente ante
 * 429/5xx y paginación estilo Laravel (`data`, `current_page`, `last_page`, `next_page_url`).
 */
export type Ss1ClientOptions = { apiBase: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number; retries?: number; sleep?: (ms: number) => Promise<void>; acceptLanguage?: string };

export class Ss1ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export class Ss1Client {
  #o: Required<Omit<Ss1ClientOptions, 'acceptLanguage'>> & { acceptLanguage: string };
  requests = 0;
  constructor(o: Ss1ClientOptions) {
    this.#o = { fetchImpl: fetch, timeoutMs: 15_000, retries: 3, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), acceptLanguage: 'es', ...o };
  }

  async get(path: string, query: Record<string, string | number | undefined> = {}): Promise<unknown> {
    const url = new URL(this.#o.apiBase + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      this.requests++;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.#o.timeoutMs);
      let res: Response | undefined;
      try {
        res = await this.#o.fetchImpl(url.toString(), { headers: { authorization: `Bearer ${this.#o.token}`, accept: 'application/json', 'accept-language': this.#o.acceptLanguage }, signal: ctl.signal });
      } catch (e) {
        if (attempt >= this.#o.retries) throw new Ss1ApiError(0, `network: ${(e as Error).message}`);
      } finally { clearTimeout(timer); }
      if (res) {
        if (res.ok) return res.json();
        if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 422) throw new Ss1ApiError(res.status, `${res.status} ${path}`);
        if (attempt >= this.#o.retries) throw new Ss1ApiError(res.status, `${res.status} ${path} tras ${attempt + 1} intentos`);
      }
      const retryAfter = Number(res?.headers.get('retry-after'));
      await this.#o.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt);
    }
  }

  /** Recorre todas las páginas de un listado Laravel (con tope de seguridad). */
  async *paginate(path: string, query: Record<string, string | number | undefined> = {}, maxPages = 200): AsyncGenerator<Record<string, unknown>> {
    for (let page = 1; page <= maxPages; page++) {
      const body = (await this.get(path, { per_page: 100, ...query, page })) as Record<string, unknown>;
      const rows = (Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []) as Record<string, unknown>[];
      for (const r of rows) yield r;
      // Laravel clásico (`last_page`, `meta.last_page`) o el formato del admin de SS1 (`pagination.total_pages`)
      const meta = (body?.pagination ?? body?.meta ?? body) as Record<string, unknown>;
      const last = Number(meta?.last_page ?? meta?.total_pages ?? page);
      if (Array.isArray(body) || rows.length === 0 || page >= last || (meta && 'next_page_url' in meta && !meta.next_page_url)) return;
    }
  }
}

/** Monto decimal en texto o número → unidades mínimas, sin coma flotante. */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'CLP', 'PYG', 'VND', 'XOF', 'XAF', 'ISK', 'UGX']);
export function toMinor(amount: unknown, currency: string): number {
  const exp = ZERO_DECIMAL.has(currency) ? 0 : 2;
  const s = typeof amount === 'number' ? amount.toFixed(exp) : String(amount ?? '').trim().replace(/,/g, '');
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`monto inválido: ${String(amount).slice(0, 20)}`);
  const frac = (m[3] ?? '').padEnd(exp, '0');
  const rounded = Number(m[2] + frac.slice(0, exp)) + (Number(frac[exp] ?? 0) >= 5 ? 1 : 0);
  return (m[1] ? -1 : 1) * rounded;
}

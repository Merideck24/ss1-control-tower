/**
 * Cliente tipado de la API v1 del CRM para el admin de SS1 (sin dependencias).
 * El token del usuario del admin viaja como Bearer; el CRM lo valida contra
 * api.syssoft1.com y deriva tenant y roles, así que el cliente no envía roles.
 */
import { CRM_ENDPOINTS, type CrmOperation, type ParamsOf } from './endpoints.generated'

export class CrmApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code }
}

export type CrmClientOptions = {
  /** URL del CRM, p. ej. https://crm.syssoft1.com (sin /api). */
  baseUrl: string
  /** Token vigente del usuario del admin. */
  getToken: () => string | null | undefined
  /** Se llama ante 401 (token vencido): el admin puede refrescar la sesión. */
  onUnauthorized?: () => void
  fetchImpl?: typeof fetch
  /** Milisegundos antes de abortar (por defecto 15 s). */
  timeoutMs?: number
}

export type CallOptions<K extends CrmOperation> = {
  params?: ParamsOf<K>
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  signal?: AbortSignal
}

export type CrmClient = {
  call<T = unknown, K extends CrmOperation = CrmOperation>(op: K, opts?: CallOptions<K>): Promise<T>
  url<K extends CrmOperation>(op: K, opts?: Pick<CallOptions<K>, 'params' | 'query'>): string
}

export function createCrmClient(o: CrmClientOptions): CrmClient {
  const base = o.baseUrl.replace(/\/+$/, '')
  const doFetch = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a))

  function url<K extends CrmOperation>(op: K, opts: Pick<CallOptions<K>, 'params' | 'query'> = {}): string {
    const ep = CRM_ENDPOINTS[op]
    const params = (opts.params ?? {}) as Record<string, string>
    const path = ep.path.replace(/\{(\w+)\}/g, (_m: string, name: string) => {
      const v = params[name]
      if (v === undefined || v === '') throw new CrmApiError(0, 'missing_param', `Falta el parámetro «${name}» para ${String(op)}`)
      return encodeURIComponent(String(v))
    })
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== '') q.set(k, String(v))
    const qs = q.toString()
    return `${base}/api/v1${path}${qs ? `?${qs}` : ''}`
  }

  async function call<T, K extends CrmOperation>(op: K, opts: CallOptions<K> = {}): Promise<T> {
    const ep = CRM_ENDPOINTS[op]
    const token = o.getToken()
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 15_000)
    opts.signal?.addEventListener('abort', () => ctl.abort())
    try {
      const res = await doFetch(url(op, opts), {
        method: ep.method,
        headers: { accept: 'application/json', ...(ep.method !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: ep.method !== 'GET' ? JSON.stringify(opts.body ?? {}) : undefined,
        signal: ctl.signal,
      })
      const type = res.headers.get('content-type') ?? ''
      const data = type.includes('application/json') ? await res.json() : await res.text()
      if (!res.ok) {
        if (res.status === 401) o.onUnauthorized?.()
        const err = (data && typeof data === 'object' ? data : {}) as { error?: string; message?: string }
        throw new CrmApiError(res.status, err.error ?? 'http_error', err.message ?? `Error ${res.status}`)
      }
      return data as T
    } catch (e) {
      if (e instanceof CrmApiError) throw e
      if ((e as Error).name === 'AbortError') throw new CrmApiError(0, 'timeout', 'El CRM no respondió a tiempo.')
      throw new CrmApiError(0, 'network', 'No se pudo conectar con el CRM.')
    } finally { clearTimeout(timer) }
  }

  return { call, url }
}

/**
 * Inyección del cliente del CRM y consultas reactivas para las vistas nativas.
 * En el admin: `app.provide(CRM_CLIENT, createCrmClient({ baseUrl, getToken: () => auth.getAccessToken }))`
 * (ver ../plugin.ts). Las vistas no conocen tokens ni URLs.
 */
import { computed, inject, onServerPrefetch, ref, shallowRef, type InjectionKey, type Ref } from 'vue'
import type { CrmClient } from '../api/client'
import { CrmApiError } from '../api/client'
import type { Session } from '../api/types'

export const CRM_CLIENT: InjectionKey<CrmClient> = Symbol('ss1-crm-client')

export function useCrmClient(): CrmClient {
  const c = inject(CRM_CLIENT, null)
  if (!c) throw new Error('Falta el cliente del CRM: registra el plugin del CRM en el admin (ver integrations/ss1-admin/crm/plugin.ts).')
  return c
}

export type Query<T> = { data: Ref<T | null>; error: Ref<string | null>; loading: Ref<boolean>; refresh: () => Promise<void> }

/** Carga datos con estado de carga y error legible; `refresh()` vuelve a pedirlos. */
export function useCrmQuery<T>(load: (c: CrmClient) => Promise<T>, opts: { immediate?: boolean } = {}): Query<T> {
  const client = useCrmClient()
  const data = shallowRef<T | null>(null) as Ref<T | null>
  const error = ref<string | null>(null)
  const loading = ref(false)
  async function refresh() {
    loading.value = true; error.value = null
    try { data.value = await load(client) }
    catch (e) { error.value = e instanceof CrmApiError ? e.message : 'Error inesperado al consultar el CRM.' }
    finally { loading.value = false }
  }
  if (opts.immediate !== false) {
    const first = refresh()
    // en renderizado de servidor (pruebas, SSR) se espera la primera carga; en el admin (SPA) no cambia nada
    onServerPrefetch(() => first)
  }
  return { data, error, loading, refresh }
}

/** Ejecuta una acción con estado de envío y mensaje para el usuario. */
export function useCrmAction() {
  const client = useCrmClient()
  const busy = ref(false)
  const message = ref<{ type: 'success' | 'error'; text: string } | null>(null)
  async function run<T>(fn: (c: CrmClient) => Promise<T>, okText: string | ((r: T) => string)): Promise<T | undefined> {
    busy.value = true; message.value = null
    try { const r = await fn(client); message.value = { type: 'success', text: typeof okText === 'function' ? okText(r) : okText }; return r }
    catch (e) { message.value = { type: 'error', text: e instanceof CrmApiError ? e.message : 'No se pudo completar la acción.' }; return undefined }
    finally { busy.value = false }
  }
  return { busy, message, run }
}

/** Permisos efectivos del usuario en el CRM (los decide el servidor del CRM a partir de CASL). */
export function useCrmPermissions() {
  const q = useCrmQuery<Session>((c) => c.call<Session>('getSession'))
  const can = (perm: string) => q.data.value?.permissions.includes(perm) ?? false
  return { session: q.data, loading: q.loading, can, ready: computed(() => q.data.value !== null) }
}

/**
 * Registro del módulo nativo del CRM en el admin (Vue 3 + Vuexy).
 *
 *   // src/plugins/crm.ts del admin
 *   import { installCrm } from '@/modules/crm/plugin'
 *   installCrm(app, { baseUrl: import.meta.env.VITE_SS1_CRM_ORIGIN, getToken: () => useAuthStore().getAccessToken, onUnauthorized: () => useAuthStore().refresh() })
 */
import type { App } from 'vue'
import { createCrmClient, type CrmClientOptions } from './api/client'
import { CRM_CLIENT } from './composables/useCrm'

export function installCrm(app: App, options: CrmClientOptions) {
  const client = createCrmClient(options)
  app.provide(CRM_CLIENT, client)
  return client
}

/**
 * Estado de la migración: vistas nativas y pestañas que siguen embebidas (iframe con
 * el puente postMessage). Al migrar una pestaña, se mueve de `embedded` a `native`.
 */
export const CRM_VIEWS = {
  native: ['control-tower', 'responsible-gaming', 'policies', 'integrations'],
  embedded: ['profile', 'segments', 'builder', 'approval', 'analytics', 'gamification', 'loyalty', 'content', 'onsite', 'copilot', 'audit'],
} as const

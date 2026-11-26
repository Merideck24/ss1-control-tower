/**
 * Widgets del CRM para el tablero «CRM» del admin (/dashboard/crm).
 *
 *   // src/pages/dashboards/crm.vue del admin, después de las filas existentes
 *   import { CrmDashboardSection } from '@/modules/crm/crm/widgets'
 *   <CrmDashboardSection v-if="$can('read', 'crm')" :brand="crmBrandKey" />
 *
 * La sección hace una sola llamada a la API del CRM. Los widgets sueltos solo reciben props,
 * por si el admin prefiere repartirlos en sus propias filas.
 */
export { default as CrmDashboardSection } from './CrmDashboardSection.vue'
export { default as CrmStatusWidget } from './CrmStatusWidget.vue'
export { default as CrmJourneysWidget } from './CrmJourneysWidget.vue'
export { default as CrmBudgetsWidget } from './CrmBudgetsWidget.vue'
export { default as CrmSuppressionWidget } from './CrmSuppressionWidget.vue'

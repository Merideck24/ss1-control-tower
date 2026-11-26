// Agregar al router del admin (junto a las rutas existentes como /dashboard/crm o /loyalty).
// Vistas nativas (Vuexy) para lo ya migrado; el resto del CRM sigue embebido por pestaña.
export const crmGamificationRoutes = [
  // El Control Tower va dentro de /dashboard/crm (widgets/CrmDashboardSection.vue); esta ruta queda como enlace directo.
  { name: 'crm-control-tower', path: '/crm/control-tower', component: () => import('./crm/pages/CrmControlTower.vue'), meta: { title: 'crm-control-tower', action: 'read', subject: 'crm' } },
  { name: 'crm-responsible-gaming', path: '/crm/responsible-gaming', component: () => import('./crm/pages/CrmResponsibleGaming.vue'), meta: { title: 'crm-responsible-gaming', action: 'update', subject: 'responsible-gaming' } },
  { name: 'crm-policies', path: '/crm/policies', component: () => import('./crm/pages/CrmPolicies.vue'), meta: { title: 'crm-policies', action: 'read', subject: 'crm' } },
  { name: 'crm-integrations', path: '/crm/integrations', component: () => import('./crm/pages/CrmIntegrations.vue'), meta: { title: 'crm-integrations', action: 'manage', subject: 'crm-settings' } },
  // Pestañas aún embebidas (perfil 360, segmentos, constructor, analítica, gamificación…)
  { name: 'crm-gamification', path: '/crm-gamification/:tab?', component: () => import('./CrmGamificationPage.vue'), props: true, meta: { title: 'crm-gamification', action: 'read', subject: 'crm' } },
]

/** Compatibilidad con la versión anterior del kit (una sola ruta embebida). */
export const crmGamificationRoute = crmGamificationRoutes[crmGamificationRoutes.length - 1]

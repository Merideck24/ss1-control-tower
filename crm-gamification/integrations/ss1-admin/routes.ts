// Agregar al router del admin (junto a las rutas existentes como /dashboard/crm o /loyalty).
export const crmGamificationRoute = {
  name: 'crm-gamification',
  path: '/crm-gamification/:tab?',
  component: () => import('./CrmGamificationPage.vue'),
  props: true,
  meta: { title: 'crm-gamification', action: 'read', subject: 'crm' },
}

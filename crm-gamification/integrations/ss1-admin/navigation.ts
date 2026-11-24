// Grupo de menú en formato Vuexy (vertical nav). Cada ítem se muestra solo con su permiso CASL.
export const crmGamificationNav = {
  title: 'CRM y Gamificación',
  icon: { icon: 'tabler-chart-dots-3' },
  action: 'read',
  subject: 'crm',
  children: [
    { title: 'Control Tower', to: 'crm-control-tower', action: 'read', subject: 'crm' },
    { title: 'Juego responsable', to: 'crm-responsible-gaming', action: 'update', subject: 'responsible-gaming' },
    { title: 'Políticas por mercado', to: 'crm-policies', action: 'read', subject: 'crm' },
    { title: 'Integraciones', to: 'crm-integrations', action: 'manage', subject: 'crm-settings' },
    { title: 'Perfil 360', to: { name: 'crm-gamification', params: { tab: 'profile' } }, action: 'read', subject: 'crm' },
    { title: 'Recorridos', to: { name: 'crm-gamification', params: { tab: 'builder' } }, action: 'read', subject: 'crm' },
    { title: 'Analítica', to: { name: 'crm-gamification', params: { tab: 'analytics' } }, action: 'read', subject: 'crm' },
    { title: 'Gamificación', to: { name: 'crm-gamification', params: { tab: 'gamification' } }, action: 'read', subject: 'crm' },
  ],
}

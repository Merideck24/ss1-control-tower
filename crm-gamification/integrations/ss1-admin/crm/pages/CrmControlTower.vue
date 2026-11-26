<script setup lang="ts">
/**
 * Control Tower como vista independiente (enlace directo /crm/control-tower). En el día a día
 * se usa enchufada en el tablero «CRM» del admin con <CrmDashboardSection />; esta vista
 * muestra la misma sección más las alertas operativas del CRM.
 */
import CrmDashboardSection from '../widgets/CrmDashboardSection.vue'

defineProps<{ brand?: string }>()
</script>

<template>
  <section class="crm-control-tower">
    <h4 class="text-h4 mb-6">Control Tower</h4>
    <CrmDashboardSection :brand="brand" title="Operación del CRM" show-alerts />
  </section>
</template>

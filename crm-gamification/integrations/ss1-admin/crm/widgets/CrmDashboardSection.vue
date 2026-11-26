<script setup lang="ts">
/**
 * Sección del CRM para el tablero «CRM» del admin (/dashboard/crm). El tablero del admin
 * sigue siendo la portada (jugadores activos, GGR, apuestas contra premios, alertas, tops);
 * esta sección agrega solo lo que es del CRM: envíos, supresiones, recorridos, presupuestos
 * de bonos, latencia y la pausa general. Hace una sola llamada a la API del CRM.
 *
 * Las alertas no se repiten aquí: viven en el sistema de alertas del admin (ver
 * docs/SS1_DATA_CONTRACT.md, sección 7). `show-alerts` las muestra en la vista independiente.
 */
import { watch } from 'vue'
import { useCrmAction, useCrmPermissions, useCrmQuery } from '../composables/useCrm'
import type { ControlTower } from '../api/types'
import { dateTime } from '../format'
import CrmBudgetsWidget from './CrmBudgetsWidget.vue'
import CrmJourneysWidget from './CrmJourneysWidget.vue'
import CrmStatusWidget from './CrmStatusWidget.vue'
import CrmSuppressionWidget from './CrmSuppressionWidget.vue'

const props = withDefaults(defineProps<{ brand?: string; title?: string; showAlerts?: boolean }>(), { brand: '', title: 'CRM · Operación', showAlerts: false })
const tower = useCrmQuery<ControlTower>((c) => c.call<ControlTower>('getControlTower', { query: { brand: props.brand || undefined } }))
// el admin pasa la marca seleccionada en su filtro: la sección la sigue
watch(() => props.brand, () => tower.refresh())
const { can } = useCrmPermissions()
const action = useCrmAction()

async function togglePause() {
  const paused = !tower.data.value?.global_pause
  await action.run((c) => c.call('postRuntimePause', { body: { paused, reason: paused ? 'Pausa desde el admin' : 'Reanudación desde el admin' } }), paused ? 'Envíos en pausa general.' : 'Envíos reanudados.')
  await tower.refresh()
}
defineExpose({ refresh: tower.refresh })
</script>

<template>
  <section class="crm-dashboard-section" aria-label="Operación del CRM">
    <div class="d-flex flex-wrap align-center gap-4 mb-4">
      <h5 class="text-h5">{{ title }}</h5>
      <VSpacer />
      <span v-if="tower.data.value" class="text-body-2 text-medium-emphasis">Datos al {{ dateTime(tower.data.value.as_of) }}</span>
      <VBtn v-if="can('runtime.global_pause') && tower.data.value" :color="tower.data.value.global_pause ? 'success' : 'error'" variant="tonal" size="small" :loading="action.busy.value" @click="togglePause">
        {{ tower.data.value.global_pause ? 'Reanudar envíos' : 'Pausa general' }}
      </VBtn>
      <VBtn variant="text" size="small" icon="tabler-refresh" aria-label="Actualizar" @click="tower.refresh()" />
    </div>

    <VAlert v-if="tower.error.value" type="error" variant="tonal" class="mb-4">{{ tower.error.value }}</VAlert>
    <VAlert v-if="action.message.value" :type="action.message.value.type" variant="tonal" class="mb-4" closable>{{ action.message.value.text }}</VAlert>
    <VProgressLinear v-if="tower.loading.value && !tower.data.value" indeterminate color="primary" />

    <template v-if="tower.data.value">
      <CrmStatusWidget :tower="tower.data.value" class="mb-2" />
      <VRow>
        <VCol cols="12" lg="8"><CrmJourneysWidget :journeys="tower.data.value.journeys" /></VCol>
        <VCol cols="12" md="6" lg="4"><CrmBudgetsWidget :budgets="tower.data.value.budgets" /></VCol>
        <VCol cols="12" md="6" lg="4"><CrmSuppressionWidget :reasons="tower.data.value.suppression_reasons" /></VCol>
        <VCol v-if="showAlerts" cols="12" md="6" lg="4">
          <VCard title="Alertas operativas" class="h-100">
            <VCardText><div v-for="(a, i) in tower.data.value.alerts" :key="i" class="text-warning">{{ a.alert }} · {{ a.player_id }}</div>
              <div v-if="!tower.data.value.alerts.length" class="text-medium-emphasis">Sin alertas</div></VCardText>
          </VCard>
        </VCol>
      </VRow>
    </template>
  </section>
</template>

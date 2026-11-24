<script setup lang="ts">
/** Control Tower nativa (Vuexy/Vuetify): estado operativo del CRM sin iframe. */
import { computed, ref, watch } from 'vue'
import { useCrmQuery, useCrmAction, useCrmPermissions } from '../composables/useCrm'
import type { ControlTower } from '../api/types'
import { dateTime, int, money, ms } from '../format'

const props = defineProps<{ brand?: string }>()
const brand = ref(props.brand ?? '')
const tower = useCrmQuery<ControlTower>((c) => c.call<ControlTower>('getControlTower', { query: { brand: brand.value || undefined } }))
watch(brand, () => tower.refresh())
const { can } = useCrmPermissions()
const action = useCrmAction()

const sum = (suffix: string) => computed(() => Object.entries(tower.data.value?.deliveries ?? {}).filter(([k]) => k.endsWith(suffix)).reduce((s, [, n]) => s + n, 0))
const delivered = sum(':accepted')
const suppressed = sum(':suppressed')
const topReasons = computed(() => Object.entries(tower.data.value?.suppression_reasons ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6))
const statusColor: Record<string, string> = { published: 'success', paused: 'warning', draft: 'secondary', pending_approval: 'info', approved: 'primary' }

async function togglePause() {
  const paused = !tower.data.value?.global_pause
  await action.run((c) => c.call('postRuntimePause', { body: { paused, reason: paused ? 'Pausa desde el admin' : 'Reanudación desde el admin' } }), paused ? 'Envíos en pausa general.' : 'Envíos reanudados.')
  await tower.refresh()
}
</script>

<template>
  <section class="crm-control-tower">
    <div class="d-flex flex-wrap align-center gap-4 mb-6">
      <h4 class="text-h4">Control Tower</h4>
      <VSpacer />
      <span v-if="tower.data.value" class="text-body-2 text-medium-emphasis">Datos al {{ dateTime(tower.data.value.as_of) }}</span>
      <VBtn v-if="can('runtime.global_pause') && tower.data.value" :color="tower.data.value.global_pause ? 'success' : 'error'" variant="tonal" :loading="action.busy.value" @click="togglePause">
        {{ tower.data.value.global_pause ? 'Reanudar envíos' : 'Pausa general' }}
      </VBtn>
      <VBtn variant="text" icon="tabler-refresh" aria-label="Actualizar" @click="tower.refresh()" />
    </div>

    <VAlert v-if="tower.error.value" type="error" variant="tonal" class="mb-4">{{ tower.error.value }}</VAlert>
    <VAlert v-if="action.message.value" :type="action.message.value.type" variant="tonal" class="mb-4" closable>{{ action.message.value.text }}</VAlert>
    <VProgressLinear v-if="tower.loading.value && !tower.data.value" indeterminate color="primary" />

    <template v-if="tower.data.value">
      <VRow class="mb-2">
        <VCol cols="12" sm="6" md="2"><VCard><VCardText><div class="text-body-2">Entregas aceptadas</div><h5 class="text-h5">{{ int(delivered) }}</h5></VCardText></VCard></VCol>
        <VCol cols="12" sm="6" md="2"><VCard><VCardText><div class="text-body-2">Supresiones</div><h5 class="text-h5">{{ int(suppressed) }}</h5></VCardText></VCard></VCol>
        <VCol cols="12" sm="6" md="2"><VCard><VCardText><div class="text-body-2">Diferidos</div><h5 class="text-h5">{{ int(tower.data.value.deferred) }}</h5></VCardText></VCard></VCol>
        <VCol cols="12" sm="6" md="2"><VCard><VCardText><div class="text-body-2">Cola de errores</div><h5 class="text-h5" :class="tower.data.value.dead_letters ? 'text-error' : ''">{{ int(tower.data.value.dead_letters) }}</h5></VCardText></VCard></VCol>
        <VCol cols="12" sm="6" md="2"><VCard><VCardText><div class="text-body-2">Estado</div><h5 class="text-h5" :class="tower.data.value.global_pause ? 'text-warning' : 'text-success'">{{ tower.data.value.global_pause ? 'En pausa' : 'Operando' }}</h5></VCardText></VCard></VCol>
        <VCol cols="12" sm="6" md="2">
          <VCard :title="`Objetivo ≤ ${tower.data.value.latency.slo_p95_ms} ms`">
            <VCardText><div class="text-body-2">Evento → decisión (p95)</div><h5 class="text-h5" :class="tower.data.value.latency.within_slo === false ? 'text-error' : 'text-success'">{{ ms(tower.data.value.latency.p95_ms) }}</h5>
              <div class="text-caption">p50 {{ ms(tower.data.value.latency.p50_ms) }} · {{ int(tower.data.value.latency.n) }} eventos</div></VCardText>
          </VCard>
        </VCol>
      </VRow>

      <VCard class="mb-6">
        <VCardItem><VCardTitle>Recorridos</VCardTitle></VCardItem>
        <VTable class="text-no-wrap">
          <thead><tr><th>Recorrido</th><th>Versión</th><th>Estado</th><th>Propósito</th><th class="text-end">Control</th><th>Instancias</th></tr></thead>
          <tbody>
            <tr v-for="j in tower.data.value.journeys" :key="`${j.id}@${j.version}`">
              <td><div class="font-weight-medium">{{ j.name }}</div><div class="text-caption">{{ j.id }}</div></td>
              <td>v{{ j.version }}</td>
              <td><VChip size="small" :color="statusColor[j.status] ?? 'secondary'" label>{{ j.status }}</VChip></td>
              <td>{{ j.purpose === 'service' ? 'Servicio' : 'Marketing' }}</td>
              <td class="text-end">{{ j.control_group_pct }} %</td>
              <td><VChip v-for="(n, s) in j.instances" :key="s" size="x-small" class="me-1">{{ s }}: {{ int(n) }}</VChip></td>
            </tr>
          </tbody>
        </VTable>
      </VCard>

      <VRow>
        <VCol cols="12" md="4">
          <VCard title="Motivos de supresión">
            <VCardText><div v-for="[r, n] in topReasons" :key="r" class="d-flex justify-space-between"><span>{{ r }}</span><span>{{ int(n) }}</span></div>
              <div v-if="!topReasons.length" class="text-medium-emphasis">Sin supresiones</div></VCardText>
          </VCard>
        </VCol>
        <VCol cols="12" md="4">
          <VCard title="Presupuestos de bonos">
            <VCardText>
              <div v-for="b in tower.data.value.budgets" :key="b.reward_id" class="mb-3">
                <div class="d-flex justify-space-between"><span>{{ b.reward_id }}</span><span>{{ money(b.committed_minor) }} / {{ money(b.budget_minor) }}</span></div>
                <VProgressLinear :model-value="b.budget_minor ? (100 * b.committed_minor) / b.budget_minor : 0" :color="b.committed_minor / Math.max(1, b.budget_minor) > 0.85 ? 'warning' : 'primary'" rounded height="6" />
              </div>
            </VCardText>
          </VCard>
        </VCol>
        <VCol cols="12" md="4">
          <VCard title="Alertas operativas">
            <VCardText><div v-for="(a, i) in tower.data.value.alerts" :key="i" class="text-warning">{{ a.alert }} · {{ a.player_id }}</div>
              <div v-if="!tower.data.value.alerts.length" class="text-medium-emphasis">Sin alertas</div></VCardText>
          </VCard>
        </VCol>
      </VRow>
    </template>
  </section>
</template>

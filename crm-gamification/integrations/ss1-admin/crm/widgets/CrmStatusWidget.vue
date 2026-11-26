<script setup lang="ts">
/** KPI de operación del CRM (entregas, supresiones, diferidos, errores, estado, latencia). Solo props: se ubica en cualquier fila del tablero. */
import { computed } from 'vue'
import type { ControlTower } from '../api/types'
import { int, ms } from '../format'

const props = defineProps<{ tower: ControlTower }>()
const sum = (suffix: string) => computed(() => Object.entries(props.tower.deliveries ?? {}).filter(([k]) => k.endsWith(suffix)).reduce((s, [, n]) => s + n, 0))
const delivered = sum(':accepted')
const suppressed = sum(':suppressed')
const kpis = computed(() => [
  { label: 'Envíos aceptados', value: int(delivered.value), icon: 'tabler-send', color: 'primary' },
  { label: 'Supresiones', value: int(suppressed.value), icon: 'tabler-shield-check', color: 'secondary' },
  { label: 'Diferidos', value: int(props.tower.deferred), icon: 'tabler-clock-pause', color: 'info' },
  { label: 'Cola de errores', value: int(props.tower.dead_letters), icon: 'tabler-alert-octagon', color: props.tower.dead_letters ? 'error' : 'success' },
  { label: 'Estado', value: props.tower.global_pause ? 'En pausa' : 'Operando', icon: props.tower.global_pause ? 'tabler-player-pause' : 'tabler-player-play', color: props.tower.global_pause ? 'warning' : 'success' },
  { label: 'Evento → decisión (p95)', value: ms(props.tower.latency.p95_ms), icon: 'tabler-bolt', color: props.tower.latency.within_slo === false ? 'error' : 'success', hint: `Objetivo ≤ ${props.tower.latency.slo_p95_ms} ms · p50 ${ms(props.tower.latency.p50_ms)} · ${int(props.tower.latency.n)} eventos` },
])
</script>

<template>
  <VRow class="crm-status-widget">
    <VCol v-for="k in kpis" :key="k.label" cols="12" sm="6" md="4" lg="2">
      <VCard :title="k.hint">
        <VCardText class="d-flex align-center gap-3">
          <VAvatar :color="k.color" variant="tonal" rounded size="40"><VIcon :icon="k.icon" size="24" /></VAvatar>
          <div>
            <div class="text-body-2 text-medium-emphasis">{{ k.label }}</div>
            <h5 class="text-h5" :class="['error', 'warning', 'success'].includes(k.color) ? `text-${k.color}` : ''">{{ k.value }}</h5>
          </div>
        </VCardText>
      </VCard>
    </VCol>
  </VRow>
</template>

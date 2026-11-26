<script setup lang="ts">
/** Recorridos del CRM con versión, estado, grupo de control e instancias. */
import type { ControlTower } from '../api/types'
import { int } from '../format'

defineProps<{ journeys: ControlTower['journeys'] }>()
const statusColor: Record<string, string> = { published: 'success', paused: 'warning', draft: 'secondary', pending_approval: 'info', approved: 'primary' }
</script>

<template>
  <VCard class="crm-journeys-widget">
    <VCardItem><VCardTitle>Recorridos del CRM</VCardTitle></VCardItem>
    <VTable class="text-no-wrap">
      <thead><tr><th>Recorrido</th><th>Versión</th><th>Estado</th><th>Propósito</th><th class="text-end">Control</th><th>Instancias</th></tr></thead>
      <tbody>
        <tr v-for="j in journeys" :key="`${j.id}@${j.version}`">
          <td><div class="font-weight-medium">{{ j.name }}</div><div class="text-caption">{{ j.id }}</div></td>
          <td>v{{ j.version }}</td>
          <td><VChip size="small" :color="statusColor[j.status] ?? 'secondary'" label>{{ j.status }}</VChip></td>
          <td>{{ j.purpose === 'service' ? 'Servicio' : 'Marketing' }}</td>
          <td class="text-end" :class="j.purpose === 'marketing' && !j.control_group_pct ? 'text-warning' : ''">{{ j.control_group_pct }} %</td>
          <td><VChip v-for="(n, s) in j.instances" :key="s" size="x-small" class="me-1">{{ s }}: {{ int(n) }}</VChip></td>
        </tr>
        <tr v-if="!journeys.length"><td colspan="6" class="text-medium-emphasis">Sin recorridos</td></tr>
      </tbody>
    </VTable>
  </VCard>
</template>

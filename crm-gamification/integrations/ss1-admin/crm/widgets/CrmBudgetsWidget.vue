<script setup lang="ts">
/** Consumo de los presupuestos de bonos del CRM; en ámbar desde el 85 %. */
import type { ControlTower } from '../api/types'
import { money } from '../format'

defineProps<{ budgets: ControlTower['budgets'] }>()
const pct = (b: ControlTower['budgets'][number]) => (b.budget_minor ? (100 * b.committed_minor) / b.budget_minor : 0)
</script>

<template>
  <VCard title="Presupuestos de bonos del CRM" class="crm-budgets-widget h-100">
    <VCardText>
      <div v-for="b in budgets" :key="b.reward_id" class="mb-3">
        <div class="d-flex justify-space-between text-body-2"><span>{{ b.reward_id }}</span><span>{{ money(b.committed_minor) }} / {{ money(b.budget_minor) }}</span></div>
        <VProgressLinear :model-value="pct(b)" :color="pct(b) > 85 ? 'warning' : 'primary'" rounded height="6" />
      </div>
      <div v-if="!budgets.length" class="text-medium-emphasis">Sin presupuestos</div>
    </VCardText>
  </VCard>
</template>

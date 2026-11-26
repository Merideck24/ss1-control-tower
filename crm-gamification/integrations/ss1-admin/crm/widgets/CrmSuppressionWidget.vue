<script setup lang="ts">
/** Motivos por los que el CRM no envió un mensaje (topes, horario silencioso, consentimiento, juego responsable…). */
import { computed } from 'vue'
import { int } from '../format'

const props = defineProps<{ reasons: Record<string, number>; limit?: number }>()
const top = computed(() => Object.entries(props.reasons ?? {}).sort((a, b) => b[1] - a[1]).slice(0, props.limit ?? 6))
const total = computed(() => top.value.reduce((s, [, n]) => s + n, 0) || 1)
</script>

<template>
  <VCard title="Motivos de supresión" class="crm-suppression-widget h-100">
    <VCardText>
      <div v-for="[r, n] in top" :key="r" class="mb-3">
        <div class="d-flex justify-space-between text-body-2"><span>{{ r }}</span><span>{{ int(n) }}</span></div>
        <VProgressLinear :model-value="(100 * n) / total" color="secondary" rounded height="6" />
      </div>
      <div v-if="!top.length" class="text-medium-emphasis">Sin supresiones</div>
    </VCardText>
  </VCard>
</template>

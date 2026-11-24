<script setup lang="ts">
/** Cola de juego responsable nativa: casos, señales e intervenciones. Solo el equipo JR gestiona. */
import { ref } from 'vue'
import { useCrmAction, useCrmPermissions, useCrmQuery } from '../composables/useCrm'
import type { RgCase, RgMonitor } from '../api/types'
import { dateTime, int } from '../format'

const monitor = useCrmQuery<RgMonitor>((c) => c.call<RgMonitor>('getRiskRgMonitor'))
const { can } = useCrmPermissions()
const action = useCrmAction()

const OUTCOMES = [
  { value: 'contacted', title: 'Contactado' },
  { value: 'limits_suggested', title: 'Límites sugeridos' },
  { value: 'escalated_to_rg', title: 'Escalado a restricción en SS1' },
  { value: 'no_action', title: 'Sin acción' },
]
const STATUS: Record<RgCase['status'], { color: string; text: string }> = { open: { color: 'error', text: 'Abierto' }, in_review: { color: 'warning', text: 'En gestión' }, closed: { color: 'success', text: 'Cerrado' } }

const closing = ref<RgCase | null>(null)
const outcome = ref('contacted')
const note = ref('')

async function take(c: RgCase) {
  await action.run((cl) => cl.call('postRiskRgCasesCaseIdAction', { params: { case_id: c.case_id, action: 'take' } }), 'Caso asignado a ti.')
  await monitor.refresh()
}
async function close() {
  if (!closing.value) return
  const ok = await action.run((cl) => cl.call('postRiskRgCasesCaseIdAction', { params: { case_id: closing.value!.case_id, action: 'close' }, body: { outcome: outcome.value, note: note.value } }), 'Caso cerrado y registrado en la auditoría.')
  if (ok !== undefined) { closing.value = null; note.value = '' }
  await monitor.refresh()
}
</script>

<template>
  <section class="crm-rg">
    <div class="d-flex align-center mb-6"><h4 class="text-h4">Juego responsable</h4><VSpacer /><VBtn variant="text" icon="tabler-refresh" aria-label="Actualizar" @click="monitor.refresh()" /></div>
    <VAlert v-if="monitor.error.value" type="error" variant="tonal" class="mb-4">{{ monitor.error.value }}</VAlert>
    <VAlert v-if="action.message.value" :type="action.message.value.type" variant="tonal" class="mb-4" closable>{{ action.message.value.text }}</VAlert>

    <template v-if="monitor.data.value">
      <VRow class="mb-2">
        <VCol v-for="k in [['Casos abiertos', monitor.data.value.summary.open, ''], ['Riesgo alto', monitor.data.value.summary.high, 'text-error'], ['Riesgo medio', monitor.data.value.summary.medium, 'text-warning'], ['En gestión', monitor.data.value.summary.in_review, ''], ['Marketing en pausa', monitor.data.value.summary.marketing_on_hold, '']]" :key="String(k[0])" cols="12" sm="6" md>
          <VCard><VCardText><div class="text-body-2">{{ k[0] }}</div><h5 class="text-h5" :class="String(k[2])">{{ int(Number(k[1])) }}</h5></VCardText></VCard>
        </VCol>
      </VRow>
      <VCard class="mb-6" title="Señales en casos abiertos">
        <VCardText>
          <VChip v-for="s in monitor.data.value.signals" :key="s.code" class="me-2 mb-2">{{ s.label }}: {{ int(s.cases) }}</VChip>
          <div class="text-caption mt-2">Intervenciones: {{ int(monitor.data.value.interventions.started) }} recorridos, {{ int(monitor.data.value.interventions.messages_accepted) }} mensajes de herramientas de control.</div>
        </VCardText>
      </VCard>
      <VCard>
        <VCardItem><VCardTitle>Cola de casos</VCardTitle></VCardItem>
        <VTable>
          <thead><tr><th>Jugador</th><th>Nivel</th><th class="text-end">Puntaje</th><th>Señales</th><th>Abierto</th><th>Estado</th><th /></tr></thead>
          <tbody>
            <tr v-for="c in monitor.data.value.cases" :key="c.case_id">
              <td>{{ c.player_id }}</td>
              <td><VChip size="small" :color="c.level === 'high' ? 'error' : 'warning'" label>{{ c.level === 'high' ? 'Alto' : 'Medio' }}</VChip></td>
              <td class="text-end">{{ c.score }}</td>
              <td><div v-for="s in c.signals" :key="s.code"><strong>{{ s.label }}</strong> <span class="text-caption">{{ s.detail }}</span></div></td>
              <td class="text-no-wrap">{{ dateTime(c.opened_at) }}</td>
              <td><VChip size="small" :color="STATUS[c.status].color" variant="tonal">{{ STATUS[c.status].text }}</VChip><div v-if="c.assignee" class="text-caption">{{ c.assignee }}</div></td>
              <td class="text-end text-no-wrap">
                <template v-if="can('rg.act') && c.status !== 'closed'">
                  <VBtn v-if="c.status === 'open'" size="small" variant="tonal" class="me-2" :loading="action.busy.value" @click="take(c)">Tomar</VBtn>
                  <VBtn size="small" variant="tonal" color="primary" @click="closing = c">Cerrar</VBtn>
                </template>
              </td>
            </tr>
            <tr v-if="!monitor.data.value.cases.length"><td colspan="7" class="text-medium-emphasis">Sin casos.</td></tr>
          </tbody>
        </VTable>
        <VCardText class="text-caption">{{ monitor.data.value.note }}</VCardText>
      </VCard>
    </template>

    <VDialog :model-value="closing !== null" max-width="520" @update:model-value="(v: boolean) => { if (!v) closing = null }">
      <VCard v-if="closing" :title="`Cerrar caso de ${closing.player_id}`">
        <VCardText>
          <VSelect v-model="outcome" :items="OUTCOMES" label="Resultado" class="mb-4" />
          <VTextarea v-model="note" label="Nota de la gestión (queda en la auditoría)" rows="3" counter />
        </VCardText>
        <VCardActions><VSpacer /><VBtn variant="text" @click="closing = null">Cancelar</VBtn><VBtn color="primary" :disabled="note.trim().length < 5" :loading="action.busy.value" @click="close">Cerrar caso</VBtn></VCardActions>
      </VCard>
    </VDialog>
  </section>
</template>

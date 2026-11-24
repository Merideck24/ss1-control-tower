<script setup lang="ts">
/** Políticas por mercado nativas: vigentes, historial y propuestas con aprobación. */
import { ref } from 'vue'
import { useCrmAction, useCrmPermissions, useCrmQuery } from '../composables/useCrm'
import type { Policies, PolicyProposal } from '../api/types'

const policies = useCrmQuery<Policies>((c) => c.call<Policies>('getPolicies'))
const { can } = useCrmPermissions()
const action = useCrmAction()
const rejectReason = ref<Record<string, string>>({})

const LABEL: Record<string, string> = { channels_enabled: 'Canales habilitados', max_marketing_per_day: 'Máx. marketing al día', max_marketing_per_week: 'Máx. por semana', quiet_hours: 'Horario silencioso', incentives_allowed: 'Incentivos permitidos', require_kyc_for_incentives: 'KYC para incentivos', rg_feed_max_staleness_ms: 'Antigüedad máx. del feed JR' }
const label = (f: string) => (f.startsWith('max_marketing_per_day_by_channel.') ? `Máx. diario por ${f.split('.')[1]}` : LABEL[f] ?? f)
function value(f: string, v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (f === 'quiet_hours') { const q = v as { start: number; end: number }; return `${q.start}:00–${q.end}:00` }
  if (f === 'rg_feed_max_staleness_ms') return `${Math.round(Number(v) / 60000)} min`
  if (typeof v === 'boolean') return v ? 'sí' : 'no'
  return Array.isArray(v) ? v.join(', ') : String(v)
}
const STATUS: Record<PolicyProposal['status'], { color: string; text: string }> = { pending: { color: 'warning', text: 'Pendiente' }, approved: { color: 'success', text: 'Aprobada y aplicada' }, rejected: { color: 'error', text: 'Rechazada' }, superseded: { color: 'secondary', text: 'Obsoleta' } }

async function decide(p: PolicyProposal, approve: boolean) {
  await action.run((c) => c.call('postPoliciesProposalsProposalIdAction', { params: { proposal_id: p.id, action: approve ? 'approve' : 'reject' }, body: approve ? {} : { reason: rejectReason.value[p.id] ?? '' } }),
    approve ? 'Política aprobada: ya se aplica a las decisiones nuevas.' : 'Propuesta rechazada.')
  await policies.refresh()
}
</script>

<template>
  <section class="crm-policies">
    <h4 class="text-h4 mb-6">Políticas por mercado</h4>
    <VAlert v-if="policies.error.value" type="error" variant="tonal" class="mb-4">{{ policies.error.value }}</VAlert>
    <VAlert v-if="action.message.value" :type="action.message.value.type" variant="tonal" class="mb-4" closable>{{ action.message.value.text }}</VAlert>
    <template v-if="policies.data.value">
      <VRow>
        <VCol v-for="p in policies.data.value.policies" :key="`${p.market}-${p.brand_id}`" cols="12" md="6">
          <VCard>
            <VCardItem>
              <VCardTitle>{{ p.market }} · {{ p.brand_id }}</VCardTitle>
              <template #append><VChip color="primary" label size="small">{{ p.version }}</VChip><VChip v-if="p.pending" color="warning" size="small" class="ms-2">{{ p.pending }} pendiente(s)</VChip></template>
            </VCardItem>
            <VTable density="compact">
              <tbody>
                <tr v-for="f in ['channels_enabled', 'max_marketing_per_day', 'max_marketing_per_week', 'quiet_hours', 'incentives_allowed', 'require_kyc_for_incentives', 'rg_feed_max_staleness_ms']" :key="f">
                  <th>{{ label(f) }}</th><td>{{ value(f, (p as Record<string, unknown>)[f]) }}</td>
                </tr>
              </tbody>
            </VTable>
            <VCardText class="text-caption">{{ p.history.length ? `Versiones aprobadas: ${p.history.map((h) => h.version).join(' · ')}` : 'Versión inicial.' }}</VCardText>
          </VCard>
        </VCol>
      </VRow>
      <VCard class="mt-6" title="Propuestas">
        <VCardText>
          <div v-for="x in policies.data.value.proposals" :key="x.id" class="mb-6">
            <div class="d-flex flex-wrap align-center gap-2 mb-2">
              <strong>{{ x.market }} · {{ x.proposed.version }}</strong><VChip size="small" :color="STATUS[x.status].color" variant="tonal">{{ STATUS[x.status].text }}</VChip>
              <span class="text-caption">por {{ x.proposed_by }}{{ x.base_version ? ` · sobre ${x.base_version}` : ' · mercado nuevo' }}</span>
            </div>
            <VTable density="compact">
              <thead><tr><th>Campo</th><th>Antes</th><th>Después</th><th /></tr></thead>
              <tbody>
                <tr v-for="c in x.changes" :key="c.field">
                  <td>{{ label(c.field) }}</td><td>{{ value(c.field.split('.')[0], c.from) }}</td><td>{{ value(c.field.split('.')[0], c.to) }}</td>
                  <td><VChip v-if="c.loosens" color="warning" size="x-small">Relaja una protección</VChip></td>
                </tr>
              </tbody>
            </VTable>
            <div v-if="x.justification" class="text-caption mt-1">Justificación: {{ x.justification }}</div>
            <div v-if="x.status === 'pending' && can('journeys.approve')" class="d-flex flex-wrap gap-2 mt-2 align-center">
              <VBtn color="primary" size="small" :loading="action.busy.value" @click="decide(x, true)">Aprobar y aplicar</VBtn>
              <VTextField v-model="rejectReason[x.id]" density="compact" hide-details label="Motivo del rechazo" style="max-inline-size: 280px" />
              <VBtn variant="tonal" color="error" size="small" :loading="action.busy.value" @click="decide(x, false)">Rechazar</VBtn>
            </div>
          </div>
          <div v-if="!policies.data.value.proposals.length" class="text-medium-emphasis">Sin propuestas.</div>
          <div class="text-caption">{{ policies.data.value.note }}</div>
        </VCardText>
      </VCard>
    </template>
  </section>
</template>

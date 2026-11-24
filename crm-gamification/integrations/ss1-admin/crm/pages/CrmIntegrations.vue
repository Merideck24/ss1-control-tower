<script setup lang="ts">
/** Integraciones nativas: llaves de servicio y webhooks salientes. Los secretos se muestran una sola vez. */
import { ref } from 'vue'
import { useCrmAction, useCrmPermissions, useCrmQuery } from '../composables/useCrm'
import type { ServiceKey, Webhooks } from '../api/types'
import { dateTime, int } from '../format'

const keys = useCrmQuery<{ keys: ServiceKey[]; note: string }>((c) => c.call('getIntegrationServiceKeys'))
const hooks = useCrmQuery<Webhooks>((c) => c.call<Webhooks>('getWebhooks'))
const { can } = useCrmPermissions()
const action = useCrmAction()

const SCOPES = ['events:write', 'players:read', 'players:write', 'onsite:serve', 'analytics:read', 'journeys:read', 'segments:read', 'rg:read', 'abuse:read', 'policies:read', 'audit:read', 'webhooks:manage']
const keyName = ref('')
const keyScopes = ref<string[]>([])
const revealed = ref<string | null>(null)

async function createKey() {
  const r = await action.run((c) => c.call<{ key: string }>('postIntegrationServiceKeys', { body: { name: keyName.value, scopes: keyScopes.value } }), 'Llave creada. Cópiala ahora: no se vuelve a mostrar.')
  if (r) { revealed.value = r.key; keyName.value = ''; keyScopes.value = [] }
  await keys.refresh()
}
async function revoke(k: ServiceKey) {
  await action.run((c) => c.call('postIntegrationServiceKeysKeyIdRevoke', { params: { key_id: k.key_id } }), `Llave «${k.name}» revocada.`)
  await keys.refresh()
}
async function setHook(id: string, a: 'pause' | 'resume') {
  await action.run((c) => c.call('postWebhooksSubscriptionIdAction', { params: { subscription_id: id, action: a } }), a === 'pause' ? 'Suscripción en pausa.' : 'Suscripción reactivada.')
  await hooks.refresh()
}
</script>

<template>
  <section class="crm-integrations">
    <h4 class="text-h4 mb-6">Integraciones del CRM</h4>
    <VAlert v-if="action.message.value" :type="action.message.value.type" variant="tonal" class="mb-4" closable>{{ action.message.value.text }}</VAlert>
    <VAlert v-if="revealed" type="warning" variant="tonal" class="mb-4" closable @click:close="revealed = null">
      Llave nueva (solo se muestra ahora): <code class="d-block mt-1" style="word-break: break-all">{{ revealed }}</code>
    </VAlert>

    <VCard class="mb-6" title="Llaves de servicio (máquina a máquina)">
      <VCardText v-if="keys.error.value"><VAlert type="error" variant="tonal">{{ keys.error.value }}</VAlert></VCardText>
      <VTable v-if="keys.data.value">
        <thead><tr><th>Nombre</th><th>Alcances</th><th>Creada</th><th>Último uso</th><th>Estado</th><th /></tr></thead>
        <tbody>
          <tr v-for="k in keys.data.value.keys" :key="k.key_id">
            <td><div>{{ k.name }}</div><div class="text-caption">{{ k.key_id }}</div></td>
            <td><VChip v-for="s in k.scopes" :key="s" size="x-small" class="me-1">{{ s }}</VChip></td>
            <td class="text-no-wrap">{{ dateTime(k.created_at) }}</td>
            <td class="text-no-wrap">{{ dateTime(k.last_used_at) }}</td>
            <td><VChip size="small" :color="k.revoked_at ? 'error' : 'success'" variant="tonal">{{ k.revoked_at ? 'Revocada' : 'Activa' }}</VChip></td>
            <td class="text-end"><VBtn v-if="!k.revoked_at && can('integration.sync')" size="small" variant="tonal" color="error" @click="revoke(k)">Revocar</VBtn></td>
          </tr>
          <tr v-if="!keys.data.value.keys.length"><td colspan="6" class="text-medium-emphasis">Sin llaves.</td></tr>
        </tbody>
      </VTable>
      <VCardText v-if="can('integration.sync')">
        <VRow>
          <VCol cols="12" md="4"><VTextField v-model="keyName" label="Nombre (p. ej. PAM producción)" /></VCol>
          <VCol cols="12" md="6"><VSelect v-model="keyScopes" :items="SCOPES" label="Alcances" multiple chips /></VCol>
          <VCol cols="12" md="2" class="d-flex align-center"><VBtn color="primary" block :disabled="keyName.trim().length < 3 || !keyScopes.length" :loading="action.busy.value" @click="createKey">Crear llave</VBtn></VCol>
        </VRow>
        <div class="text-caption">{{ keys.data.value?.note }}</div>
      </VCardText>
    </VCard>

    <VCard title="Webhooks salientes">
      <VTable v-if="hooks.data.value">
        <thead><tr><th>Destino</th><th>Eventos</th><th>Estado</th><th class="text-end">Entregadas</th><th class="text-end">Pendientes</th><th class="text-end">Fallidas</th><th /></tr></thead>
        <tbody>
          <tr v-for="s in hooks.data.value.subscriptions" :key="s.id">
            <td><div>{{ s.url }}</div><div class="text-caption">{{ s.description || s.id }} · secreto {{ s.secret_hint }}</div></td>
            <td><VChip v-for="e in s.events" :key="e" size="x-small" class="me-1">{{ e }}</VChip></td>
            <td><VChip size="small" :color="s.status === 'active' ? 'success' : s.status === 'paused' ? 'warning' : 'error'" variant="tonal">{{ s.status }}</VChip></td>
            <td class="text-end">{{ int(s.deliveries.delivered) }}</td><td class="text-end">{{ int(s.deliveries.pending) }}</td><td class="text-end">{{ int(s.deliveries.failed + s.deliveries.dead) }}</td>
            <td class="text-end"><VBtn v-if="can('integration.sync')" size="small" variant="tonal" @click="setHook(s.id, s.status === 'active' ? 'pause' : 'resume')">{{ s.status === 'active' ? 'Pausar' : 'Reactivar' }}</VBtn></td>
          </tr>
          <tr v-if="!hooks.data.value.subscriptions.length"><td colspan="7" class="text-medium-emphasis">Sin suscripciones. Créalas desde la vista clásica del CRM.</td></tr>
        </tbody>
      </VTable>
      <VCardText v-if="hooks.data.value" class="text-caption">{{ hooks.data.value.note }}</VCardText>
    </VCard>
  </section>
</template>

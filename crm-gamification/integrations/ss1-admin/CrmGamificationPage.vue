<script setup lang="ts">
/**
 * Página del admin que muestra el CRM y Gamificación embebido.
 * Ajusta los imports de tus stores: aquí se asume el store de auth del admin
 * (getAccessToken) y la habilidad CASL (useAbility de @casl/vue).
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAbility } from '@casl/vue'
import { useI18n } from 'vue-i18n'
import { createCrmBridge, type CrmSession } from './crmBridge'
// ⚠️ Ajustar a los stores reales del admin
import { useAuthStore } from '@/stores/auth'
import { useThemeConfigStore } from '@/stores/themeConfig'

const CRM_ORIGIN = import.meta.env.VITE_SS1_CRM_ORIGIN || 'https://crm.syssoft1.com'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const theme = useThemeConfigStore()
const ability = useAbility()
const { locale } = useI18n()

const frame = ref<HTMLIFrameElement | null>(null)
const height = ref(900)
const title = ref('CRM y Gamificación')
const src = computed(() => `${CRM_ORIGIN}/`)

function session(): CrmSession | null {
  const token = auth.getAccessToken
  if (!token || !auth.user) return null
  return {
    accessToken: token,
    tenantId: String(auth.user.client?.slug ?? auth.user.client_id ?? ''),
    user: { id: String(auth.user.id), name: auth.user.name },
    abilities: ability.rules as CrmSession['abilities'],
    locale: (['es', 'en', 'pt'].includes(locale.value) ? locale.value : 'es') as CrmSession['locale'],
    theme: { primary: theme.primaryColor, logo: theme.logo },
  }
}

let bridge: ReturnType<typeof createCrmBridge> | null = null
onMounted(() => {
  bridge = createCrmBridge(window, {
    crmOrigin: CRM_ORIGIN,
    target: () => frame.value?.contentWindow,
    getSession: session,
    initialTab: typeof route.params.tab === 'string' ? route.params.tab : undefined,
    onTitle: (t, tab) => { title.value = t; if (tab && tab !== route.params.tab) router.replace({ name: 'crm-gamification', params: { tab } }) },
    onResize: (h) => { height.value = h },
  })
})
onBeforeUnmount(() => bridge?.dispose())
// Si el token se renueva, el CRM recibe la sesión actualizada
watch(() => auth.getAccessToken, () => bridge?.refreshSession())
watch(() => route.params.tab, (tab) => { if (typeof tab === 'string') bridge?.navigate(tab) })
</script>

<template>
  <section>
    <VCard class="mb-4">
      <VCardItem>
        <VCardTitle>{{ title }}</VCardTitle>
      </VCardItem>
    </VCard>
    <iframe
      ref="frame"
      :src="src"
      :style="{ width: '100%', height: `${height}px`, border: 0, display: 'block' }"
      title="CRM y Gamificación"
      referrerpolicy="strict-origin"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
    />
  </section>
</template>

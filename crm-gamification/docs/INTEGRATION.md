# Integración con admin.syssoft1.com

El CRM se integra al admin de SS1 como un módulo más del mismo ecosistema: mismo usuario, mismos permisos, mismo tema y la misma API (`https://api.syssoft1.com`).

## 1. Modo embebido (A1 · listo)

El admin muestra el CRM en un `<iframe>` dentro de su propio layout (menú lateral y barra). Al detectar que está embebido, el CRM oculta su menú, su logo y los selectores de tenant y rol, y muestra la navegación interna como pestañas.

### Protocolo `postMessage` v1

| Dirección | Mensaje | Contenido |
|---|---|---|
| CRM → admin | `ss1-crm:ready` | `{ version: 1 }` al cargar |
| admin → CRM | `ss1-crm:session` | `{ version: 1, accessToken, tenantId, user: { id, name? }, abilities: CaslRule[], locale? }` |
| admin → CRM | `ss1-crm:navigate` | `{ version: 1, tab }` (por ejemplo `tower`, `profile`, `loyalty`) |
| CRM → admin | `ss1-crm:title` | `{ version: 1, title, tab }` al cambiar de sección |
| CRM → admin | `ss1-crm:resize` | `{ version: 1, height }` para ajustar el alto del iframe sin doble scroll |

Reglas de seguridad:
- El CRM solo acepta mensajes cuyo `event.source` sea la ventana padre **y** cuyo `event.origin` esté en la lista permitida. Por defecto es `https://admin.syssoft1.com`. Se amplía solo en el despliegue (`CRM_ALLOWED_ORIGINS=https://admin.syssoft1.com,https://staging-admin.syssoft1.com npm run build:static`), nunca desde la URL.
- El CRM envía sus mensajes solo al origen del admin que le entregó la sesión.
- El token vive en memoria. No se guarda en `localStorage` ni en cookies del CRM.
- Sin sesión válida en 8 segundos, el CRM muestra un aviso y no carga datos.
- Con servidor (A2), el token se valida en el backend contra `api.syssoft1.com` y **el servidor decide los roles**. El mapeo en el navegador solo se usa en la demo estática.

### Permisos CASL → roles del CRM

`src/integration/ss1Auth.ts` es la única tabla de mapeo. `manage` cubre cualquier acción, `all` cualquier sujeto y las reglas invertidas restan.

| Rol del CRM | Se concede con |
|---|---|
| Analista CRM | `create`/`update` sobre `crm`, `crm-campaign`, `bonus-campaign` o `telegram-campaign` |
| Aprobador | `approve` sobre `crm-approval` o `bonus-campaign` |
| Soporte | `read` sobre `player`, `crm` o `chat-support` |
| Juego responsable | `update` sobre `kyc`, `responsible-gaming` o `player-limit` |
| Admin de tenant | `manage` sobre `all`, `client` o `crm-settings` |
| Auditor | `read` sobre `audit-log`, `report` o `crm` |

Los nombres de sujeto `crm`, `crm-campaign`, `crm-approval`, `responsible-gaming` y `crm-settings` son nuevos y deben crearse en el admin (ver A6). Los demás ya existen en sus rutas.

### Ejemplo en el admin (Vue 3)

```vue
<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
const CRM_ORIGIN = 'https://crm.syssoft1.com' // donde se despliegue el CRM
const frame = ref(null); const height = ref(800)
function onMessage (e) {
  if (e.origin !== CRM_ORIGIN) return
  if (e.data?.type === 'ss1-crm:ready') {
    frame.value.contentWindow.postMessage({ type: 'ss1-crm:session', version: 1, accessToken: authStore.getAccessToken, tenantId: authStore.clientId, user: { id: String(authStore.user.id), name: authStore.user.name }, abilities: ability.rules, locale: i18n.global.locale.value }, CRM_ORIGIN)
  }
  if (e.data?.type === 'ss1-crm:resize') height.value = e.data.height
}
onMounted(() => addEventListener('message', onMessage))
onBeforeUnmount(() => removeEventListener('message', onMessage))
</script>
<template><iframe ref="frame" :src="`${CRM_ORIGIN}/`" :style="{ width: '100%', height: height + 'px', border: 0 }" title="CRM y gamificación" /></template>
```

## 2. Identidad en el servidor (A2 · listo)

`src/integration/ss1Identity.ts`. Con `Authorization: Bearer <token del admin>` el servidor:

1. Llama a `GET ${SS1_API_BASE}${SS1_PROFILE_PATH}` (por defecto `https://api.syssoft1.com/admin/bootstrap`) con ese token.
2. Extrae usuario, operador y reglas CASL. Acepta `{ data: { user, abilities } }`, `{ user, permissions: ["crm.read"] }`, `client.slug` o `client_id`, entre otras formas.
3. Traduce el operador a tenant del CRM con `CRM_TENANT_MAP` (JSON, por ejemplo `{"rumbawin":"tenant-rumbawin"}`) y rechaza con 403 si la petición pide otro tenant.
4. Decide los roles con la tabla CASL → roles. **Ignora `x-roles` del navegador.**
5. Cachea el resultado 60 s por hash SHA-256 del token (nunca el token en claro) y los rechazos 10 s.

| Variable | Uso | Valor por defecto |
|---|---|---|
| `SS1_API_BASE` | API del admin | `https://api.syssoft1.com` |
| `SS1_PROFILE_PATH` | Endpoint que devuelve usuario, operador y permisos | `/admin/bootstrap` (**confirmar con el equipo del admin**) |
| `CRM_TENANT_MAP` | Operador del admin → tenant del CRM | `{}` (usa el slug) |
| `CRM_DEV_AUTH` | Acepta cabeceras de desarrollo sin token. Solo demo local | desactivado |

Respuestas: 401 sin token o token inválido, 403 tenant ajeno, 502 si la API de SS1 no responde. `npm start` arranca la demo con `CRM_DEV_AUTH=1`; `npm run start:prod` exige token.

## 3. Pendiente (siguientes iteraciones)

- **A3** Conectores con la API del admin: `/admin/statistics/*`, `/admin/transactions/report/players`, `/admin/withdrawal-requests`, `/admin/alerts/stats`, `/admin/bonus-campaigns/trigger-catalog`.
- **A4** Webhook firmado para eventos del PAM en tiempo real.
- **A5** Tema del tenant desde `/admin/theme-config`.
- **A6** Kit para el repo del admin: ruta `/crm`, ítem de menú, sujetos CASL y componente contenedor.

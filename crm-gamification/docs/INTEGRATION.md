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

## 3. Conectores con la API del admin (A3 · listo)

`src/integration/ss1Client.ts` y `src/integration/ss1Connectors.ts`.

- **Cliente:** token del usuario del admin (delegado), tiempo límite de 15 s, reintentos con espera creciente ante 429/5xx (respeta `Retry-After`), sin reintento ante 401/403/404/422. Paginación Laravel (`data`, `current_page`, `last_page`, `next_page_url`, `meta`).
- **Montos:** decimales en texto → unidades mínimas sin coma flotante (`toMinor`), con monedas sin decimales (CLP, JPY…).
- **Idempotencia:** `event_id = ss1:<recurso>:<id>:<tipo>`; repetir una sincronización no duplica nada.

| Conector | Endpoint | Eventos generados |
|---|---|---|
| `players` | `/admin/players` (configurable con `SS1_PLAYERS_PATH`) | `player.registered` (email enmascarado, atribución si trae afiliado o campaña) y `player.verified` si el KYC está aprobado |
| `financial` | `/admin/transactions/financial` | `deposit.settled`, `deposit.reversed`, `withdrawal.settled` según tipo y estado |
| `withdrawals` | `/admin/withdrawal-requests` | `withdrawal.settled` (aprobados o pagados) |
| catálogo | `/admin/bonus-campaigns/trigger-catalog` | Opciones de disparadores alineadas con las campañas de bonos del admin |

API del CRM:
- `POST /api/integration/ss1/sync` (solo `tenant_admin`): `{ connectors?: ["players","financial","withdrawals"], since?: ISO, mode?: "backfill" | "live" }`. Cada conector reporta leídos, ingeridos, duplicados, rechazados, omitidos (con ejemplos de motivo) y error; un conector fallido no detiene a los demás. Queda en auditoría.
- **`backfill` (por defecto):** actualiza perfiles y métricas pero **no** dispara recorridos, mensajes, bonos ni avisos de fidelidad para hechos históricos. **`live`:** eventos nuevos con efectos.
- `GET /api/integration/ss1/trigger-catalog` (analista, aprobador, admin).
- Sin token del admin (demo estática o modo desarrollo) responden 409 `not_integrated`.

**A confirmar con el equipo del admin:** la ruta del listado de jugadores, los nombres de campo (tipo y estado de transacción, KYC, afiliado), los filtros de fecha (`updated_since`) y si existe un endpoint de apuestas liquidadas por jugador (para GGR real; hoy el admin expone `/admin/transactions/report/players` agregado).

## 4. Webhook firmado para eventos en tiempo real (A4 · listo)

`POST /api/ingest/ss1` (`src/integration/webhook.ts`). Máquina a máquina: no usa token de usuario.

| Cabecera | Valor |
|---|---|
| `X-SS1-Tenant` | Tenant del CRM; elige el secreto |
| `X-SS1-Signature` | `t=<unix seg>,v1=<hex HMAC-SHA256(secreto, "<t>.<cuerpo crudo>")>` |

- Cuerpo: un evento normalizado (ver `contracts/events.asyncapi.yaml`) o `{ "events": [ … ] }` con hasta 500 eventos; máximo 1 MB.
- Rechazos: 401 si la firma, el tenant o el tiempo (±300 s) no son válidos; 413 si el lote es muy grande; 400 si no es JSON.
- Cada evento debe tener `tenant_id` igual a `X-SS1-Tenant` (si no, `tenant_mismatch` para ese evento).
- Los reenvíos son seguros: el mismo `event_id` se reporta como `duplicate` y no repite efectos.
- Modo **live**: los eventos disparan recorridos y fidelidad.
- Secretos: `CRM_WEBHOOK_SECRETS='{"tenant-rumbawin":"…"}'` (gestor de secretos en producción; rotación agregando el nuevo antes de retirar el anterior).

Ejemplo de envío desde el backend del admin (Laravel):

```php
$body = json_encode(['events' => $events], JSON_UNESCAPED_SLASHES);
$t = time();
$sig = hash_hmac('sha256', "{$t}.{$body}", config('services.ss1_crm.webhook_secret'));
Http::withHeaders([
    'X-SS1-Tenant' => $tenant,
    'X-SS1-Signature' => "t={$t},v1={$sig}",
])->withBody($body, 'application/json')->retry(3, 500)->post(config('services.ss1_crm.url').'/api/ingest/ss1');
```

## 5. Tema del operador (A5 · listo)

`src/integration/theme.ts`. El CRM toma el color principal y el logo de cada operador:

1. **Servidor:** `GET /api/integration/ss1/theme` lee `/admin/theme-config` con el token del usuario (caché de 5 min por tenant). Acepta `primary_color`, `primaryColor`, `colors.primary`, `theme.colors.primary`, `logo_url`, `logo`, entre otras formas.
2. **Respaldo:** el admin puede enviar `theme: { primary, logo }` en el mensaje `ss1-crm:session`.

Salvaguardas:
- Si el color no alcanza contraste 3:1 sobre las tarjetas oscuras (`#111`), se mantiene el dorado de SS1 y se registra un aviso.
- El color del texto sobre botones (negro o blanco) se elige por contraste.
- El logo solo se acepta por `https` desde dominios de SS1 (`syssoft1.sfo3.digitaloceanspaces.com`, `api.syssoft1.com`, `admin.syssoft1.com`).
- Todos los acentos (botones, pestaña activa, bordes, barras) derivan de `--brand`; las gráficas mantienen su paleta validada.

## 6. Pendiente (siguientes iteraciones)

- **A6** Kit para el repo del admin: ruta `/crm`, ítem de menú, sujetos CASL y componente contenedor.

# Kit de integración para admin.syssoft1.com

Con este kit, el CRM y Gamificación se integra al admin (Vue 3 + Vuetify/Vuexy + CASL) como un módulo más: mismo menú, misma sesión, mismos permisos y el tema del operador.

La migración es por etapas:

- **Vistas nativas:** las pantallas ya migradas son componentes Vuexy que llaman a la API v1 del CRM.
- **Vistas embebidas:** el resto sigue en un iframe con el puente `postMessage`.

| Vista | Estado | Ruta del admin |
|---|---|---|
| Control Tower | **Enchufado** en el tablero «CRM» del admin | `/dashboard/crm` (y enlace directo `/crm/control-tower`) |
| Juego responsable | **Nativa** | `/crm/responsible-gaming` |
| Políticas por mercado | **Nativa** | `/crm/policies` |
| Integraciones (llaves de servicio y webhooks) | **Nativa** | `/crm/integrations` |
| Perfil 360, Segmentos, Constructor, Aprobación, Analítica, Gamificación, Fidelidad, Plantillas, Contenido en sitio, Copiloto, Auditoría | Embebida | `/crm-gamification/:tab` |

## Archivos

| Archivo | Qué hace |
|---|---|
| `crm/api/endpoints.generated.ts` | Mapa tipado de las 86 operaciones de la API v1. Se genera con `npm run admin:client` desde el catálogo de la API, y una prueba falla si queda desactualizado. |
| `crm/api/client.ts` | Cliente sin dependencias. Arma rutas `/api/v1` con parámetros codificados, envía el token del admin como Bearer y aplica un tiempo de espera. Los errores son tipados (`CrmApiError`) y avisa ante un 401 para refrescar la sesión. |
| `crm/api/types.ts` | Formas de respuesta que usan las vistas nativas. |
| `crm/composables/useCrm.ts` | `useCrmQuery` (carga, error y refresco), `useCrmAction` (envío con mensaje) y `useCrmPermissions` (permisos efectivos que decide el CRM). |
| `crm/widgets/*.vue` | Control Tower en piezas para el tablero «CRM» del admin: `CrmDashboardSection` (una sola llamada) y los widgets sueltos de estado, recorridos, presupuestos y supresiones. |
| `crm/pages/*.vue` | Vistas nativas con componentes de Vuetify (`VCard`, `VTable`, `VChip`, `VDialog`…), igual que Vuexy, y con los íconos `tabler-*` del admin. |
| `crm/plugin.ts` | `installCrm(app, { baseUrl, getToken, onUnauthorized })` y el estado de la migración (`CRM_VIEWS`). |
| `routes.ts`, `navigation.ts` | Rutas y grupo de menú con permisos CASL por ítem. |
| `CrmGamificationPage.vue`, `crmBridge.ts` | Vista embebida y puente `postMessage` v1 para las pestañas aún no migradas. |
| `permissions.json` | Sujetos CASL nuevos y roles sugeridos. |

## Pasos en el repo del admin

1. Copiar `integrations/ss1-admin/` a `src/modules/crm/`.
2. En un plugin del admin, llamar a `installCrm(app, { baseUrl: import.meta.env.VITE_SS1_CRM_ORIGIN, getToken: () => useAuthStore().getAccessToken, onUnauthorized: () => useAuthStore().refresh() })`. Hay que ajustar los nombres de los stores a los reales.
3. Registrar `crmGamificationRoutes` y `crmGamificationNav`.
4. Crear en el backend los permisos de `permissions.json` y asignarlos a los roles.
5. Desplegar el CRM con:
   - `CRM_ALLOWED_ORIGINS=https://admin.syssoft1.com`;
   - `SS1_API_BASE`, `SS1_PROFILE_PATH` y `CRM_TENANT_MAP`;
   - `DATABASE_URL`.

   `CRM_ALLOWED_ORIGINS` también habilita CORS para esos orígenes, sin comodín. Así las vistas nativas pueden llamar a la API directamente. Los detalles están en `../../docs/INTEGRATION.md`.

## Control Tower dentro de `/dashboard/crm`

El tablero «CRM» del admin sigue siendo la portada: jugadores activos, GGR, apuestas contra premios, mapa de actividad, alertas por detector y tops. El Control Tower no lo duplica. Agrega debajo solo lo que es del CRM: envíos y supresiones, recorridos con su grupo de control, presupuestos de bonos, latencia evento → decisión y la pausa general.

```vue
<!-- src/pages/dashboards/crm.vue del admin, al final de las filas existentes -->
<script setup>
import { CrmDashboardSection } from '@/modules/crm/crm/widgets'
</script>

<template>
  <!-- … filas actuales del tablero … -->
  <CrmDashboardSection v-if="$can('read', 'crm')" :brand="crmBrandKey" class="mt-6" />
</template>
```

- `brand`: la marca elegida en el filtro del tablero, con la clave que usa el CRM (por ejemplo `rumbawin`). Vacío muestra todas. Al cambiar, la sección se recarga.
- La sección hace una sola llamada (`getControlTower`). Si el admin prefiere repartir las piezas en sus propias filas, los widgets sueltos (`CrmStatusWidget`, `CrmJourneysWidget`, `CrmBudgetsWidget`, `CrmSuppressionWidget`) solo reciben props.
- **Alertas:** no se muestran en la sección, porque el admin ya tiene su sistema de alertas. Las del CRM (`rg.case_opened`, `abuse.reviewed`, `delivery.failed`, `reward.failed`) salen por los webhooks firmados y la idea es que el admin las registre como un detector más. Hace falta que SS1 diga cómo crear alertas en su sistema; ver `docs/SS1_DATA_CONTRACT.md`, sección 7.
- El menú del CRM ya no tiene ítem «Control Tower». La vista suelta `/crm/control-tower` sigue disponible como enlace directo y sí muestra las alertas del CRM.

## Cómo migrar otra pestaña

1. Crear `crm/pages/CrmX.vue` con `useCrmQuery((c) => c.call('<operación>'))`. Los nombres de operación están en `endpoints.generated.ts`.
2. Mostrar los botones con `useCrmPermissions().can('<permiso>')`. Igual el servidor rechaza lo que el rol no permite.
3. Agregar la ruta y el ítem de menú, mover la pestaña de `embedded` a `native` en `CRM_VIEWS` y sumar su caso a `test/admin_vue.test.ts`.

## Verificación

`test/admin_vue.test.ts`:

- compila las vistas con el compilador oficial de SFC;
- las empaqueta con esbuild;
- las renderiza en el servidor con Vue y Vuetify reales, contra datos simulados y contra el servidor real del CRM (con una llave de servicio);
- comprueba que los botones dependen de los permisos.

`npm run typecheck` revisa el kit con su propio `tsconfig.json` (resolución tipo bundler, como Vite).

## Seguridad

- Vistas nativas:
  - el token del admin viaja solo al origen del CRM (`baseUrl`);
  - el CRM lo valida contra api.syssoft1.com y deriva tenant y roles; el cliente no envía roles.
- Vistas embebidas:
  - el puente solo acepta mensajes del origen y del iframe del CRM;
  - el token se envía solo a ese origen, nunca con `'*'`;
  - el iframe usa `sandbox` y `referrerpolicy="strict-origin"`.

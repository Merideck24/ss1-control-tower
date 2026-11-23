# Kit de integración para admin.syssoft1.com

Archivos para el repo del admin (Vue 3 + Vuetify/Vuexy + CASL). Con ellos el CRM y Gamificación aparece como un módulo más: mismo menú, misma sesión, mismos permisos y el tema del operador.

| Archivo | Qué hace |
|---|---|
| `crmBridge.ts` | Implementa el protocolo `postMessage` v1 del lado del admin: envía la sesión al `ready`, reenvía al renovar el token, navega a una pestaña, recibe título y alto. Sin dependencias. |
| `CrmGamificationPage.vue` | Página con el iframe del CRM. Toma token, usuario, operador, reglas CASL, idioma y tema de los stores del admin. **Ajustar los imports de stores.** |
| `routes.ts` | Ruta `/crm-gamification/:tab?` con `meta: { action: 'read', subject: 'crm' }`. El parámetro `tab` permite enlaces directos (`/crm-gamification/loyalty`). |
| `navigation.ts` | Ítem del menú vertical de Vuexy, visible con `read:crm`. |
| `permissions.json` | Sujetos CASL nuevos y roles sugeridos. |

## Pasos

1. Copiar `crmBridge.ts` y `CrmGamificationPage.vue` a `src/pages/crm-gamification/` y ajustar los imports de los stores de auth y tema.
2. Registrar la ruta de `routes.ts` y el ítem de `navigation.ts`.
3. Crear los permisos de `permissions.json` en el backend y asignarlos a los roles.
4. Definir `VITE_SS1_CRM_ORIGIN` con la URL donde se despliegue el CRM.
5. Desplegar el CRM con `CRM_ALLOWED_ORIGINS=https://admin.syssoft1.com` (y staging si aplica), `SS1_API_BASE`, `SS1_PROFILE_PATH`, `CRM_TENANT_MAP` y `CRM_WEBHOOK_SECRETS` (ver `../../docs/INTEGRATION.md`).
6. Opcional: enviar eventos en tiempo real al webhook firmado desde los jobs de Laravel.

## Seguridad

- El puente solo acepta mensajes del origen del CRM configurado y de su iframe.
- El token se envía solo al origen del CRM, nunca con `'*'`.
- El iframe usa `sandbox` y `referrerpolicy="strict-origin"`.
- La autoridad sobre permisos está en el servidor del CRM, que valida el token contra `api.syssoft1.com`.

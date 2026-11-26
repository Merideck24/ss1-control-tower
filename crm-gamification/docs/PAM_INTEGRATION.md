# Integración con el PAM de SS1

Cómo el CRM lee los datos del PAM de SS1 (admin.syssoft1.com), qué es de quién y cómo se activa por fases. Complementa el [contrato de datos](SS1_DATA_CONTRACT.md) (rutas y campos confirmados) y [INTEGRATION.md](INTEGRATION.md) (API del CRM hacia SS1).

## 1. Propiedad de los datos

| Dueño | Datos | Regla |
|---|---|---|
| **PAM (SS1)** | Identidad y registro, KYC, juego responsable (autoexclusión, límites), saldo y transacciones financieras, apuestas y premios, bonos del PAM | El CRM **solo lee**. Nunca escribe en el PAM. Ante discrepancia gana el PAM y el CRM vuelve a leer. |
| **CRM** | Consentimientos de marketing por canal, segmentos y ciclo de vida, recorridos, mensajes y recibos, misiones, puntos de fidelidad, monedas, experimentos | El CRM es la fuente; los expone a SS1 por la API v1 y webhooks firmados. |

Cada dato del PAM llega al perfil con **procedencia** (`source: ss1.admin`, fecha, `event_id` y versión). Si falta el estado de juego responsable o está desactualizado, el CRM bloquea el marketing (fail-closed). Código: `src/integration/pam.ts` (`PAM_OWNERSHIP`).

## 2. Autenticación y alcances

- **Operadores** (personas en el admin): el CRM valida el Bearer del admin contra `GET /admin/auth/me` (pedido a SS1; aún no existe). Tenant y rol salen de la sesión, nunca del cliente.
- **Servicio** (sincronización): una credencial de servicio de **solo lectura** emitida por SS1, guardada como secreto del entorno (`SS1_API_TOKEN`), nunca en el repositorio, en logs ni en el contexto de la IA. Los reportes de sincronización no incluyen la credencial (prueba `pam_contract`: «sin filtrar el token»).
- Alcances mínimos por conector (`PAM_SCOPES`): `players:read`, `transactions:read`, `withdrawals:read`. Ningún alcance de escritura.
- 401/403 no se reintentan; 5xx y errores de red se reintentan con espera exponencial y `Retry-After`.

## 3. Mapeo de identificadores

| PAM | CRM | Nota |
|---|---|---|
| `client` | `tenant_id` | Tabla `tenantMap` en la configuración del despliegue |
| marca del cliente | `brand_id` | Un tenant puede tener varias marcas |
| `players.id` | `player_id` (texto) | Estable; es la llave de todo el CRM |
| `players.username` | — | Solo para resolver los movimientos de juego, que traen `player: <username>` |
| `transactions.id` | `event_id = ss1:<recurso>:<id>:<tipo>` | Determinista: resincronizar no duplica |

Un movimiento cuyo username no se puede resolver se **omite con motivo** («jugador sin id»), no se inventa.

## 4. Idempotencia y reintentos

- `event_id` determinista por fila del PAM, dedup por `(tenant, event_id)` en la ingesta. Segunda pasada completa: 0 eventos nuevos y totales idénticos (prueba de contrato).
- Lo que no se puede ingerir va a la **cola de errores** de la ingesta (`dead_letters` en el Control Tower) con su motivo.
- Envíos y premios llevan llave de idempotencia `instancia:nodo`; un resultado incierto se concilia antes de reenviar.

## 5. Adaptadores reemplazables

Los conectores dependen de la interfaz `PamSource` (`paginate(path, query)`), no de un cliente HTTP:

| Adaptador | Uso |
|---|---|
| `Ss1Client` | HTTP al admin de SS1: paginación `pagination.total_pages`, filtros `filter[...]`, reintentos |
| `SandboxPam` | Filas en memoria con la forma del admin; desarrollo, demo y pruebas |

Un adaptador nuevo (otro PAM, un bus de eventos de SS1) se acepta **solo si pasa la suite de contrato** `test/pam_contract.test.ts`, que hoy corre igual contra los dos:

1. sincronización completa con todas las páginas y omisiones explicadas;
2. mapeo de IDs y username → id;
3. KYC y JR del PAM con procedencia `ss1.admin`, y autoexclusión que bloquea el marketing;
4. cero escrituras al PAM;
5. resincronización idempotente sin cruce de tenants;
6. 401 explícito, sin reintento y sin filtrar la credencial;
7. alcances solo de lectura y activación gradual estable.

## 6. Plan de activación

| Fase | Fuente | Efectos | Puerta para pasar a la siguiente |
|---|---|---|---|
| **Sandbox** | `SandboxPam` con filas reales anonimizadas de SS1 | Simulados | Suite de contrato en verde con esas filas |
| **Piloto** | `Ss1Client` solo lectura, una marca (RumbaWin CO) | In-app sin incentivos | 14 días: depósitos conciliados ±0,5 % contra el reporte diario del admin; 0 envíos a autoexcluidos |
| **Activación gradual** | `Ss1Client` | 10 % → 50 % → 100 % de jugadores por hash estable (`inRollout`) | Sin alertas críticas abiertas, fallas de envío < 1 %, aprobación de Compliance en cada paso |

Quien entra al 10 % sigue dentro al 50 % (hash estable): no hay jugadores que entren y salgan entre pasos.

## 7. Qué falta de SS1

1. Credencial de servicio de solo lectura para un entorno sandbox o piloto.
2. `GET /admin/auth/me`.
3. Campos de jugador: email, idioma, zona horaria, afiliado y consentimiento de marketing.
4. Fuente de casos de soporte, para que la etapa «Soporte» del recorrido deje de mostrarse «sin fuente».
5. Filas reales anonimizadas, para correr la suite de contrato en la fase sandbox.

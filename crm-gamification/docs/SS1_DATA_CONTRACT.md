# Contrato de datos con el admin de SS1

**Fuente:** el código del front-end publicado en admin.syssoft1.com (las llamadas que hace a api.syssoft1.com y los campos que lee) y el estado HTTP de cada ruta en api.syssoft1.com. Una ruta que existe responde 401 sin token; una ruta que no existe responde 404, porque el enrutado ocurre antes de la autenticación.

**Límite:** no se pudo leer ninguna respuesta real, porque el token de servicio guardado para api.syssoft1.com es rechazado. Por eso los nombres de campo son seguros (los lee el propio admin), pero falta comprobarlos contra datos reales. Los puntos pendientes están marcados con **Confirmar**.

**Fecha:** 2026-11-25.

## Resumen

| Tema | Lo que asumía el CRM | Lo que hace el admin | Estado en el CRM |
|---|---|---|---|
| Identidad | `GET /admin/bootstrap` devuelve usuario y permisos | `/admin/bootstrap` devuelve catálogos. El usuario y sus reglas CASL solo llegan en `POST /admin/auth/login` y no hay un GET que los devuelva | El extractor acepta `{ userData, userAbilities }` y la ruta por defecto es `/admin/auth/me`. **Hay que pedírsela a SS1** |
| Transacciones financieras | `type: "deposit"`, `status: "approved"` | `transaction_type` y `status` son números | Corregido. Antes se descartaban todos los depósitos |
| Jugadores | `country` es texto | `country.value` es el ISO. Hay `kyc_status` y `responsible_gaming` | Corregido. La autoexclusión llega como `rg.status_changed` |
| Apuestas | Sin conector | `GET /admin/transactions/report/all`: movimientos DEBIT, CREDIT, ROLLBACK y FREE_SPIN | Conector nuevo `games` |
| Paginación | `last_page` | `pagination.total_pages` | Corregido. Antes se leía solo la primera página |
| Filtros | `updated_since` | `filter[fromDate]`, `filter[toDate]`, `filter[timezone]`, `filter[per_page]`… | Corregido para `financial` y `games` |

## 1. Identidad y permisos

Al iniciar sesión, `POST /admin/auth/login` devuelve:

```json
{
  "accessToken": "…",
  "userData": { "id": 12, "clientId": 3, "clientParentId": null, "role": "…", "roleType": "…", "timezone": "America/Bogota", "walletType": "regular|internal" },
  "userAbilities": [{ "action": "read", "subject": "crm" }]
}
```

Si la cuenta tiene doble factor, la respuesta trae `two_factor_required` y la sesión se entrega en `POST /admin/auth/two-factor/verify`. `userAbilities` se carga directo en CASL.

`GET /admin/bootstrap` sí existe, pero trae `countries`, `languages`, `timezones`, `currencies`, `standardCurrencies`, `categories`, `tags`, `providers`, `clients`, `childClients`, `siteTemplates`, `siteFonts`, `roles` y `commissionTypes`. No trae el usuario.

No existe ruta para resolver un token. Devuelven 404 `/admin/auth/me`, `/admin/auth/user`, `/admin/auth/refresh`, `/admin/auth/session`, `/admin/auth/profile`, `/admin/me`, `/admin/user` y `/admin/profile`.

**Pedido a SS1:** `GET /admin/auth/me` con el Bearer del usuario, que devuelva el mismo `{ userData, userAbilities }` del login, o 401. Es la única forma de que el servidor del CRM valide al usuario sin confiar en el navegador. El CRM ya lo espera en esa ruta, que se puede cambiar con `SS1_PROFILE_PATH`.

Notas:
- El operador sale de `userData.clientId` y se traduce a tenant con `CRM_TENANT_MAP`.
- Un `clientParentId` distinto de null indica un sub-cliente.
- **Confirmar:** que el CRM se mapea por `clientId` y no por el padre.

## 2. Jugadores: `GET /admin/players`

Campos que lee la vista de jugadores:

| Campo | Forma | Uso en el CRM |
|---|---|---|
| `id` | número | `player_id` |
| `username` | texto | Mapa username → id. Los movimientos de juego solo traen el username |
| `client` | id del operador | — |
| `country` | `{ value: "CO", … }` | `country` |
| `currency` / `currency_iso` | ISO | — |
| `status` | — | — |
| `kyc_status` | `unverified`, `pending`, `approved`, `rejected` o `revoked` | `approved` → `player.verified` |
| `responsible_gaming` | `{ self_excluded_until, has_deposit_limits }` | Autoexclusión vigente → `rg.status_changed: self_excluded`. Límites → `limited` |
| `balance`, `bonus_balance` | — | — |
| `created_at`, `updated_at` | fecha | Registro y cambio de estado |

Otras rutas del jugador:
- `/admin/players/{id}`
- `/admin/players/{id}/financial-summary`
- `/admin/players/{id}/wallet-statement`
- `/admin/players/{id}/limits`
- `/admin/players/{id}/kyc`
- `/admin/players/{id}/loyalty`
- `/admin/players/{id}/self-exclusion/lift`

**Confirmar:**
- La lista no muestra email, idioma, zona horaria ni afiliado. El CRM usa valores por defecto (`es`, `America/Bogota`, sin adquisición) hasta saber en qué ruta están.
- Para el consentimiento de marketing no se encontró ningún campo. **Hace falta saber dónde se guarda** antes de enviar comunicaciones reales.
- Los parámetros de filtro de esta lista.

## 3. Transacciones financieras: `GET /admin/transactions/financial`

| Campo o filtro | Valores |
|---|---|
| `transaction_type` | `1` depósito · `2` retiro · `3` bono · `4` ajuste |
| `status` | `0` fallida · `1` pendiente · `2` completada |
| Filtros | `filter[client_id]`, `filter[provider_id]`, `filter[currency_id]`, `filter[transaction_type]`, `filter[status]`, `filter[player_id]`, `filter[parent_id]`, `filter[fromDate]`, `filter[toDate]`, `filter[per_page]` y `page` |
| Respuesta | `{ data: [...], pagination: { current_page, total_pages, total } }` |

El CRM convierte un depósito completado en `deposit.settled` y un retiro completado en `withdrawal.settled`. Bonos y ajustes se omiten.

**Confirmar:**
- Cómo llega el jugador en cada fila (`player_id` u objeto `player`).
- Qué estado tiene un contracargo, que el CRM registra como `deposit.reversed`.
- Si `amount` llega como texto con separador de miles.

## 4. Apuestas: `GET /admin/transactions/report/all`

Es el listado de la vista Transacciones del admin. Cada fila es un movimiento de la wallet de juego.

| Campo | Forma |
|---|---|
| `id` | id interno del movimiento |
| `transaction_type` | `DEBIT` apuesta · `CREDIT` premio · `ROLLBACK` reversión · `FREE_SPIN` giro gratis |
| `amount`, `balance` | monto y saldo |
| `currency` / `currency_label` | moneda |
| `player` | **username** (no el id) |
| `client`, `brand`, `game.name`, `provider` | `provider.is_external_wallet` indica wallet externa |
| `provider_round` | id de ronda del proveedor |
| `is_free_spin` | booleano |
| `status` | `true` si la wallet lo confirmó |
| `created_at` | fecha |

**Filtros:**
- `filter[transaction_type]`: 1 DEBIT, 2 CREDIT, 3 ROLLBACK, 4 FREE_SPIN.
- `filter[provider_id]`, `filter[brand_id]`, `filter[game_id]`, `filter[currency_id]`.
- `filter[fromDate]`, `filter[toDate]`, `filter[timezone]`.
- `filter[settlement]`: `settled` (por defecto) o `failed`.
- `filter[include_zero_amounts]`, `filter[search_type]` y `filter[search_value]`, `filter[per_page]` (50 a 500) y `page`.

**Respuesta:**
- `data` y `pagination`.
- `totals`: `{ total_debit, total_credit, total_rollback, total_free_spin, profit, return_to_player }`. Cada total es `{ raw, formatted, large_number, count }`.
- `totals_by_currency`, `type_counts`, `currency` y `period`.

**Definición de beneficio del admin (GGR):** apostado − premios − reversiones, contando solo movimientos confirmados por la wallet.
- Una reversión solo cuenta si devolvió una apuesta confirmada.
- La apuesta de un giro gratis no se cobra y no cuenta como apostado.
- Los premios de giros gratis sí cuentan como premio.

**Conector `games`:** convierte cada movimiento en un `bet.settled`, con id determinista `ss1:gametx:<id>`.
- DEBIT es el stake.
- CREDIT es el premio, con stake 0.
- ROLLBACK es un stake negativo.
- FREE_SPIN y los movimientos no confirmados se omiten.
- El perfil cuenta una apuesta solo cuando el stake es positivo.

Así, apostado menos premios del CRM es igual al `profit` del admin.

**Confirmar:**
- Que `amount` llega en unidades de la moneda y no ya formateado con otro separador.
- Si la fila incluye `player_id` aunque la vista no lo muestre. Eso evitaría depender del username.
- Si hay movimientos de apuestas deportivas en esta misma ruta. Hoy todo se marca como `casino`.

## 5. Conciliación (criterio de salida de la fase 1)

| Ruta | Para qué |
|---|---|
| `GET /admin/transactions/report/daily/brands` | Totales diarios por marca (apostado, premios, beneficio). Es la referencia para cuadrar el GGR por día y por marca |
| `GET /admin/transactions/report/players` | Por jugador: `total_bet`, `total_win`, `total_rollbacks`, `net_profit`, `total_deposits`, `net_deposits`, `games_played`, `last_activity` |
| `GET /admin/transactions/report/reconciliation` | Anomalías de la wallet: `orphan_debit`, `credit_without_debit`, `pending_settlement`, `unresolved_settlement`, `flagged_unmatched`, `casing_inconsistency` |
| `GET /admin/statistics/bets-timeline` | Series de apostado, premios y beneficio por día, hora, semana o mes |

Las rutas están en `SS1_ENDPOINTS.reportDailyBrands` y `SS1_ENDPOINTS.reportPlayers`. El comparador automático se construye cuando haya un token válido para probar con datos reales.

## 6. Otras rutas que existen (útiles más adelante)

| Área | Rutas |
|---|---|
| Retiros | `/admin/withdrawal-requests` (y aprobar o rechazar) |
| Juegos y proveedores | `/admin/games`, `/admin/providers` |
| KYC | `/admin/kyc/submissions` |
| Fidelidad | `/admin/loyalty/programs/{id}/players` |
| Giros y apuestas gratis | `/admin/phoenix/free-bets`, `/admin/digitain/free-games` |
| Límites | `/admin/player-limits/settings/{id}` |
| Operadores y marcas | `/admin/clients`, `/admin/brands` |

## 7. Ya existe un panel «CRM» en el admin

El admin tiene una vista llamada «CRM» con:
- KPI de jugadores activos;
- GGR;
- apuestas contra premios;
- mapa de calor de actividad;
- alertas por detector y severidad;
- top de marcas.

Conviene decidir con SS1 si el Control Tower del CRM la reemplaza o se integra con ella, para no duplicar pantallas.

## Lo que necesitamos de SS1

1. `GET /admin/auth/me` con la forma del login (sección 1).
2. Un token de servicio de solo lectura válido para api.syssoft1.com, para comprobar estos campos con datos reales.
3. Dónde están el email, el idioma y la zona horaria del jugador, el afiliado y el **consentimiento de marketing**.
4. Las confirmaciones marcadas en las secciones 3 y 4.

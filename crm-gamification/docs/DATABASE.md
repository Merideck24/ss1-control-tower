# Base de datos (PostgreSQL)

## Resumen

- **Motor:** PostgreSQL 15 o superior (probado con 16).
- **Esquema:** `db/migrations/001_init.sql`. Las migraciones se aplican con `npm run db:migrate`, en orden, con bloqueo entre instancias y suma de verificación. Si alguien edita una migración ya aplicada, el proceso se detiene.
- **Aislamiento entre tenants:** Row Level Security en todas las tablas de negocio. La app se conecta con el rol `crm_app`, y cada transacción fija `app.tenant_id` (`withTenant`). Sin ese valor, la base no devuelve filas. Escribir filas de otro tenant falla.
- **Solo-anexar:** `events` y `audit_log` tienen triggers que impiden `UPDATE` y `DELETE`. Además, al rol de la app se le quitan esos permisos.
- **Reglas que garantiza la propia base** (y no solo el código):
  - claves de idempotencia únicas: otorgamientos, recibos, canjes, interacciones en el sitio y movimientos de fidelidad y de monedas;
  - presupuesto de bonos (`committed_minor <= budget_minor`);
  - stock y saldo de monedas no negativos;
  - un solo caso de juego responsable abierto por jugador;
  - quien aprueba no puede ser quien creó, en recorridos, políticas y contenido.
- **Auditoría:** queda en una cadena de hashes que continúa entre reinicios (`AuditLog.resume`). `PgAuditStore.verify` detecta cualquier alteración. La columna `details` es de tipo `json` y no `jsonb`, porque el hash depende del orden de las claves.

## Roles

| Rol | Uso | Permisos |
|---|---|---|
| `crm_owner` (o el dueño del esquema) | Migraciones y reconstrucción | Dueño de las tablas, `BYPASSRLS` |
| `crm_app` (lo hereda `crm_app_login`) | La aplicación | CRUD con RLS. Sin `UPDATE`/`DELETE` en `events` ni `audit_log` |

Variables de entorno:

- `DATABASE_URL`: aplicación, rol `crm_app_login`.
- `DATABASE_MIGRATION_URL`: migraciones.
- `DATABASE_MAINTENANCE_URL`: lectura de la cadena de auditoría completa.
- `DATABASE_POOL_MAX`: tamaño del pool de conexiones.

## Fase 1 (hecha): lo que no se puede perder

| Dato | Cómo se guarda | Al reiniciar |
|---|---|---|
| Eventos (fuente de verdad) | `events`, por lotes cada ~20 ms y deduplicados por `tenant_id + event_id` | Se reconstruyen perfiles, métricas de rendimiento, hechos para modelos, abuso de bonos y conversiones de A/B. La deduplicación sobrevive |
| Auditoría | `audit_log`, en orden y con la cadena continua | Sigue desde el último eslabón |

**Prueba de humo (demo de 90 días):**

| Paso | Resultado |
|---|---|
| Primer arranque | 28.895 eventos y 4.511 registros de auditoría guardados en unos 7 s |
| Reinicio | Los 28.895 eventos se reconstruyen y las cifras de rendimiento coinciden. La auditoría continúa en #4.512 con la cadena íntegra |

**Pruebas:** `test/db_postgres.test.ts` corre contra un PostgreSQL real (en CI, un servicio `postgres:16`). Cubre:

- migraciones idempotentes y protegidas contra cambios;
- RLS;
- tablas solo-anexar y restricciones de negocio;
- persistencia, reinicio y reconstrucción;
- detección de una auditoría alterada.

**Limitación de la fase 1:** los módulos con estado propio siguen en memoria y se pierden al reiniciar. Son los recorridos en curso, los otorgamientos y recibos, la bandeja, los saldos de fidelidad y de monedas, los canjes, los casos de juego responsable, las revisiones, las campañas, los borradores, las propuestas de política y las suscripciones de webhooks. Al reiniciar se reconstruyen como proyección pero sin efectos: no se reenvían mensajes ni se vuelven a otorgar bonos.

## Fase 2: cada módulo a su tabla, con escritura previa al efecto

Las tablas ya existen en `001_init.sql`. El orden sugerido es por riesgo de pérdida:

1. `reward_items` / `reward_grants`: reserva con `UPDATE … SET committed_minor = committed_minor + $v` en la misma transacción que el otorgamiento.
2. `journey_instances` y `split_assignments`: las esperas pendientes se retoman con el índice `journey_instances_due`.
3. `delivery_receipts` e `inbox_items`.
4. `loyalty_ledger`, `coin_ledger` / `coin_balances`, `store_items` / `redemptions`: el canje se hace en una transacción con `SELECT … FOR UPDATE`.
5. `rg_cases`, `abuse_reviews` y `policy_proposals` / `market_policies`.
6. Configuración (`journey_versions`, `templates`, `gamification_definitions`, `onsite_campaigns`, `content_drafts`). Al migrarla, el sembrado de demostración deja de ejecutarse en cada arranque.
7. `webhook_subscriptions` / `webhook_deliveries`, con el secreto cifrado por KMS, y `outbox` → bus de eventos.

Criterio de salida de la fase 2: reiniciar el servidor en cualquier momento no pierde ni duplica ningún efecto. Se comprueba con pruebas de caos (matar el proceso entre la reserva y la confirmación).

## Escala

- **Particionado:** `events` por mes (`occurred_at`) cuando pase de unos 100 millones de filas.
- **Réplica de lectura:** para analítica.
- **Agregados diarios materializados:** rendimiento y payback dejan de recorrer todos los hechos en cada consulta.

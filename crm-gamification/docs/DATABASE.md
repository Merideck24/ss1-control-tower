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

## Fase 2, incremento 3 (hecho): instancias, recibos y reprocesos

Migración `002_runtime_persistence.sql`. Se aplica sobre una base de la fase 1 sin perder datos: solo agrega columnas, amplía restricciones y crea índices. La prueba `DB fase 2: actualizar desde la fase 1…` lo comprueba con filas existentes.

### Qué se guarda

| Dato | Tabla | Qué incluye |
|---|---|---|
| Versiones de recorridos | `journey_versions` | Definición completa, estado (con `closed`), autor, aprobador y firma. Sin esto, una instancia apuntaría tras el reinicio a una versión que ya no existe |
| Instancias | `journey_instances` | Versión fijada, paso actual, estado, `wake_at`, paso diferido por horario silencioso, traza con cada decisión de política, evento de origen (`trigger_event_id`) y sus datos para la plantilla |
| Recibos | `delivery_receipts` | Clave de idempotencia, canal, plantilla, estado, motivo, intentos, id del proveedor, fecha de respuesta del proveedor, origen (recorrido, versión, instancia, paso, propósito, evento) y variables para reenviar con la misma clave |
| Reprocesos | `reprocess_attempts` | Solo-anexar, con RLS: actor, fecha, motivo, resultado y el motivo y estado originales de la falla |
| Auditoría | `audit_log` | Ahora con `writer`: una cadena por proceso (`web`, `worker` o id de réplica), cada una verificable por separado |

### Estados de un envío

Los mismos significados en Control Tower, la cola de fallas y los informes (`src/channels/channels.ts`):

| Estado | Significa | ¿Efecto externo? |
|---|---|---|
| `requested` | El CRM registró la intención y está llamando al proveedor | Puede estar ocurriendo |
| `accepted` | El proveedor aceptó el mensaje (no garantiza que llegó) | Sí |
| `delivered` | El proveedor confirmó la entrega | Sí |
| `failed` | El proveedor lo rechazó o no se pudo llamar | No |
| `uncertain` | Se llamó y no hubo respuesta, o el proceso cayó a mitad de la llamada | Quizá: se concilia antes de reenviar |
| `suppressed` / `deferred` | El CRM decidió no enviar (política) o aplazar (horario silencioso) | No |

«Aceptado» en los conteos suma `accepted` y `delivered`.

### Procesos

| Proceso | Comando | Qué hace |
|---|---|---|
| Web | `CRM_ROLE=web npm start` | API y eventos. Ejecuta el primer paso de un recorrido al llegar el evento. No despierta esperas. Lee de la base lo que cambia el worker |
| Worker | `npm run worker` | Sin API. Reconstruye perfiles desde los eventos (sin efectos), sigue los eventos nuevos y es el único que despierta esperas y diferidos |
| Proceso único | `npm start` con `DATABASE_URL` y sin `CRM_ROLE` | Hace las dos cosas (desarrollo, demo con base) |

- **Un solo worker activo.** El que obtiene el bloqueo consultivo de la base; los demás esperan y toman el relevo si ese cae.
- **Quien recibe un evento de primera mano ejecuta sus efectos.** El otro proceso solo lo proyecta. Así nada se ejecuta dos veces.
- **Sincronización.** Cada proceso escribe lo suyo por lotes (≈20 ms) y lee lo del otro cada segundo por `updated_at`, con 5 s de solape. Restaurar es idempotente y nunca pisa un estado local más nuevo: la traza de una instancia solo crece y el `at` de un recibo solo avanza.
- **Reinicio a mitad de un envío.** Lo que quedó `requested` pasa a `uncertain` al arrancar el worker y entra a la cola de fallas. Allí se concilia con el proveedor antes de cualquier reenvío. El runtime nunca reenvía un `uncertain` por su cuenta.
- **Reproceso entre réplicas.** El bloqueo vive en la fila del recibo (`reprocess_lock_by/at`, vence a los 2 minutos): dos réplicas no reprocesan la misma falla a la vez.
- **Topes de marketing.** Al cargar, los envíos de marketing aceptados de los últimos 7 días vuelven a contar para los topes diarios y semanales.

### Índices de operación

`delivery_receipts_open` (fallas abiertas por tenant y fecha), `delivery_receipts_journey`, `delivery_receipts_instance`, `journey_instances_due` (esperas por vencer), `journey_instances_journey` (seguimiento por recorrido y versión) y los de `updated_at` para la sincronización.

### Pruebas

`test/db_runtime.test.ts` corre contra PostgreSQL real, en su propia base descartable. Cubre:

- la actualización desde la fase 1;
- una espera que sobrevive al reinicio de la web y del worker sin reenvíos;
- la sincronización web ⇄ worker con dos cadenas de auditoría íntegras;
- un envío interrumpido que queda incierto y se concilia sin reenviar;
- dos réplicas que reprocesan a la vez con un solo envío;
- RLS y solo-anexar en el historial de reprocesos, y el relevo del worker.

Comando: `npm run test:db` con `DATABASE_URL` de un rol administrador sobre una base descartable.

### Sigue en memoria (pendiente)

Otorgamientos de bonos y presupuesto, bandeja in-app, libros de fidelidad y monedas, canjes, casos de juego responsable, revisiones de abuso, campañas en sitio, borradores de contenido, propuestas de política y webhooks. Al reiniciar se reconstruyen como proyección pero sin efectos. Su orden sugerido:

1. `reward_grants` con la reserva de presupuesto en la misma transacción;
2. `inbox_items`;
3. libros de fidelidad y monedas, y canjes con `SELECT … FOR UPDATE`;
4. casos y revisiones;
5. configuración restante;
6. webhooks con secreto cifrado y `outbox`.

**Limitación conocida.** La web aplica las salidas por evento (`exit_on`, cambio de juego responsable) a instancias en espera y el worker las despierta. Si los dos ocurren en el mismo segundo sobre la misma instancia, gana la última escritura. Se mitiga porque la web escribe antes de leer y el worker revalida la política al despertar, de modo que una autoexclusión igual bloquea el envío. La solución completa es una columna de versión con escritura condicional.

## Escala

- **Particionado:** `events` por mes (`occurred_at`) cuando pase de unos 100 millones de filas.
- **Réplica de lectura:** para analítica.
- **Agregados diarios materializados:** rendimiento y payback dejan de recorrer todos los hechos en cada consulta.

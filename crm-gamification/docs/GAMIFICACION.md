# Gamificación ampliada · SS1 CRM & Loyalty

**Estado al 27 de noviembre de 2026** (commit `47aad3f`, CI verde: https://github.com/Merideck24/ss1-control-tower/actions/runs/46023285268 — 204 pruebas y 31 de navegador). Primera entrega funcional del alcance de gamificación de las fases 2 y 3. Primero se construyó el flujo completo que pedía el encargo:

> crear reto → aprobar → inscribir jugador sintético → recibir evento → actualizar progreso → confirmar recompensa → desbloquear logro → generar tarjeta compartible

Ese flujo funciona de punta a punta, en el backoffice y en el teléfono del jugador, con persistencia, permisos, auditoría y métricas. Los regalos instantáneos ya funcionan de punta a punta (§2, fila 2). Torneos ampliados y clasificaciones también (filas 3 y 5). Los concursos **siguen pendientes**.

`AGENTS.md` y `SS1_Plan_CRM_Gamificacion_IA.md` no existen en el repositorio. Se trabajó sobre el código y `docs/PLAN.md`, reutilizando lo que ya existía:
- misiones e insignias;
- torneos;
- tienda y monedas;
- libro de fidelidad;
- servicio de bonos con conciliación;
- políticas;
- auditoría;
- persistencia.

## 1. Cómo probarlo

```bash
npm start                                   # demo con datos sintéticos (3 retos aprobados, 24 jugadores inscritos)
# o con PostgreSQL y worker:
npm run db:migrate && CRM_ROLE=web npm start   # más: npm run worker
```

- **Backoffice:** pestaña «Retos y logros». Como analista: crear reto, enviar y simular. Como aprobador: aprobar. Como admin: pausar o cerrar.
- **Jugador:** pestaña «Fidelidad (móvil)», bloque «Retos» y «Mis logros». Con rol «Admin de tenant» aparece «Demo: simular actividad del jugador» para enviar eventos y ver el progreso en vivo.
- **Demo publicada:** mismas pantallas, sin servidor. El tiempo real va por sondeo con el mismo cursor.

## 2. Matriz de funcionalidades

Estados:
- **Hecho:** de punta a punta y con pruebas.
- **Parcial:** existe pero falta parte del encargo.
- **Pendiente:** no está.

| # | Funcionalidad | Estado | Qué hay | Evidencia | Qué falta |
|---|---|---|---|---|---|
| 1 | Recompensas en tiempo real | **Parcial** | Eventos confirmados actualizan el progreso de los retos. XP (libro de fidelidad), monedas y bonos del catálogo. El bono queda «pendiente» hasta que el servicio de bonos lo confirma. Sin duplicados (por `event_id` y período). Los reversos compensan. Avisos por SSE con reanudación (`Last-Event-ID`) y resincronización | `test/gamification_challenges.test.ts` (flujo completo, reverso, bono pendiente, reconexión); `test/e2e/stack/gamification_realtime.spec.ts` (SSE real) | Reglas de recompensa **fuera** de los retos (motor general por tenant, marca, segmento, mercado y temporada). Hoy esas dimensiones existen solo a nivel de reto. Pantalla de movimientos propia de recompensas (hoy se ven en Fidelidad) |
| 2 | Regalos instantáneos | **Hecho** | Campañas de regalo con XP, monedas o bono del catálogo, para jugadores concretos o un segmento. Lo crea una persona y lo aprueba otra (firma sobre el contenido). Al aprobar se asigna de forma determinista: destinatarios en orden de id hasta el cupo; quien no es elegible queda fuera con su motivo. Aviso en vivo (`gift.received`). «Mis regalos» en el teléfono del jugador con estados disponible, reclamado, en pausa, vencido y revocado. Reclamación única aunque lleguen dos solicitudes a la vez (cambio de estado sincrónico y clave idempotente por regalo y jugador, que el libro durable y el servicio de bonos rechazan si se repite, también entre réplicas). Revalidación de juego responsable y política al reclamar. Vencimiento automático y cierre con motivo que revoca lo no reclamado. Pestaña «Regalos» con métricas y definiciones. Persistencia en la migración 005 | `test/gamification_gifts.test.ts` (4), `test/db_runtime.test.ts` (regalos tras reinicio), `test/e2e/demo/gifts.spec.ts` | Regalos disparados por un evento (p. ej. cumpleaños) sin pasar por una campaña: hoy se hace con un recorrido del Constructor |
| 3 | Torneos | **Hecho** | Reglas fijadas al iniciar: versión y hash de las reglas; cambiarlas exige un torneo nuevo y el hash se verifica al aprobar. Inscripción automática o voluntaria (`opt_in`, con juego responsable). Eventos tardíos: cuentan si ocurrieron dentro de la ventana y llegan dentro del margen (`late_grace_minutes`, 60 por defecto); fuera del margen o después del cierre se registran y no cuentan. Cierre con conciliación: la clasificación se reconstruye desde los eventos, se excluye a quien tenga restricción al cerrar y se proponen los premios **sin pagar**. Aprobación de resultados por otra persona (ni quien creó ni quien cerró), que paga una sola vez con clave idempotente y revalida juego responsable y política. Reconstrucción auditable (`GET /gamification/tournaments/:id/rebuild`, hash igual al del cierre). Aviso en vivo de posición y resultado. Persistencia de reglas, inscripciones y puntajes (migraciones 005 y 006) | `test/gamification_tournaments.test.ts`, `test/games.test.ts`, `test/db_runtime.test.ts` (torneo tras reinicio, cierre pendiente que se aprueba después) | Torneos por equipos; premios por porcentaje de participantes |
| 4 | Retos y misiones | **Hecho** | Retos diarios, semanales y de temporada. Modos individual, secuencial y de varios pasos. Pasos de ejemplo: completar perfil, explorar secciones, rondas de casino, apuestas deportivas, nivel de fidelidad. Inscripción voluntaria con preferencia de avisos y tope de 3 retos activos. Aprobación por otra persona con firma, versión fijada por inscripción, simulación sin efectos, pausa y cierre con motivo. Misiones de la fase anterior intactas | `test/gamification_challenges.test.ts` (7), `test/e2e/demo/gamification.spec.ts` | Plantillas de retos por mercado; programación recurrente automática de retos diarios |
| 5 | Tablas de clasificación | **Hecho** | Por torneo, por reto y por temporada de XP. Orden y desempate visibles: mayor puntaje; a igual puntaje, quien llegó primero; cada fila indica si está empatada. Paginación (hasta 50 por página) y fila propia aparte aunque esté fuera de la página. Alias solo con permiso del jugador; si no, nombre opaco estable («Jugador ·a1b2»); avatar con inicial y color derivado, sin imágenes. El jugador puede ocultarse (sigue contando como «Jugador oculto»). No aparece quien tiene restricción, caso abierto o señal reciente. El sitio nunca recibe ids de jugador. Visibilidad por tabla: pública, solo participantes u oculta (solo backoffice). Actualización en vivo (`leaderboard.updated`). Pestaña «Clasificaciones» y bloque en el teléfono del jugador | `test/gamification_tournaments.test.ts`, `test/e2e/demo/leaderboards.spec.ts` | Avatares con imagen (requiere que SS1 los provea y modere) |
| 6 | Logros y compartir | **Hecho** | Catálogo de 4 logros con niveles y fecha. «Mis logros» en el perfil del jugador. Alias con permiso explícito para mostrarlo. Tarjeta SVG 1200×630 con la identidad de SS1, sin saldos, depósitos, apuestas ni datos personales. Descarga, Web Share API o copiar enlace, siempre con confirmación previa. Enlace público con id opaco de 22 caracteres, revocable y sin indexar. Métricas separadas: clic, descarga, visita atribuida y publicación confirmada (solo con evidencia del canal) | `test/gamification_challenges.test.ts`, `test/e2e/stack/gamification_realtime.spec.ts` (enlace público real, revocación) | Plantillas de tarjeta por marca (hoy usan los tokens SS1), evidencia de publicación desde cada red social (requiere integraciones) |
| 7 | Concursos | **Pendiente** | — | — | Todo el módulo: bases, requisitos, participaciones, revisión y descalificación motivada, aprobación de ganadores, interfaz para un sorteo autorizado |
| 8 | Backoffice y Control Tower | **Parcial** | Pestañas «Regalos» (métricas por campaña) y «Clasificaciones» (paginada, con ids internos y cómo lo ve el sitio). Torneos con cierre y aprobación de resultados en «Gamificación». Pestaña «Retos y logros»: métricas por reto con definiciones, filtro por estado, acciones por rol, formulario sin JSON, simulación, catálogo de logros y métricas de tarjetas. Tarjeta en el Control Tower: inscritos, inicio, finalización, recompensas, duplicados suprimidos, retraso p95 e interacciones con tarjetas | `test/e2e/demo/gamification.spec.ts` | Pantalla de Concursos. Filtros por marca, mercado y fecha en la pestaña (la API ya filtra por marca y mercado). Retención D7/D30 por cohorte de participantes. Grupo de control para medir el incremento de un reto |
| 9 | Arquitectura y controles | **Parcial** | Aislamiento por tenant en API, base (RLS), canal en vivo y enlaces. Identidad desde la sesión. Idempotencia por evento y período. Revalidación de política antes de cada incentivo. Bonos con reserva de presupuesto y conciliación. Auditoría de cada paso. Persistencia de retos, inscripciones, logros, alias, enlaces y métricas (migración 003). **Libros de XP y monedas durables** (migración 004): asiento único por referencia, saldo de monedas en la misma transacción con `balance >= 0` en la base, carga al arrancar y lectura de los asientos de la otra réplica en cada ciclo, sin efectos | `test/db_runtime.test.ts` (gamificación y libros tras reinicio, réplica que recibe los asientos), `test/gamification_challenges.test.ts` (aislamiento) | Sincronización de la gamificación entre réplicas de la web (hoy se carga al arrancar). Borradores de retos propuestos por el copiloto |
| 10 | Experiencia y diseño | **Parcial** | Prioridad móvil (sin desborde a 390 px), estados de carga, vacío, error, reconexión y éxito; animación breve solo con movimiento permitido; tokens de marca SS1 en tarjetas; textos del jugador en ES, EN y PT | `test/e2e/demo/gamification.spec.ts` (axe 0 violaciones, 390 px) | Textos del backoffice en EN y PT; tokens SS1 aplicados al resto de la interfaz (hoy usa el tema del admin) |
| 11 | Verificación | **Hecho para lo entregado** | Flujo completo, duplicados, secuencia, reversos, juego responsable, presupuesto e incertidumbre del bono, versiones, reconexión, aislamiento entre tenants, persistencia, SSE real, enlace público real | §5 | Pruebas de regalos, torneos ampliados y concursos cuando existan |

## 3. Juego responsable (no configurable)

- Ningún reto puede invitar a **recuperar pérdidas**: se rechaza el texto al guardar.
- Los **retos diarios** no admiten pasos de depósito ni de montos apostados.
- No participa quien tiene **restricción de juego responsable**, un **caso de riesgo abierto** o una **señal de riesgo** en los últimos 30 días.
- Si la señal llega durante el reto, la inscripción se **suspende**: sin progreso, sin premio y sin avisos. El jugador ve «En pausa por tu seguridad».
- La participación es **voluntaria**. Se respeta la exclusión de gamificación y hay un máximo de 3 retos a la vez.
- Antes de otorgar un **bono** se revalida la política vigente: consentimiento, KYC, mercado y caso de riesgo.

## 4. Métricas: definiciones y ventanas

| Métrica | Definición |
|---|---|
| Elegibles | Jugadores del tenant que hoy cumplen marca, mercado, segmento, vigencia y juego responsable |
| Inscritos | Inscripciones activas (voluntarias, sin salida ni suspensión) |
| Participaciones | Inscripción × período (un reto diario cuenta una vez por día) |
| Inicio | Participaciones con algún avance ÷ participaciones |
| Finalización | Participaciones completadas ÷ participaciones |
| Recompensas confirmadas | XP y monedas registradas en el libro del CRM; bonos confirmados por el servicio de bonos (incluida la conciliación) |
| Pendientes | Bonos pedidos sin confirmación (respuesta incierta) |
| Duplicados suprimidos | Eventos repetidos (mismo `event_id`) que no volvieron a contar |
| Retraso p95 | Del `occurred_at` del evento a la actualización del progreso, sobre las últimas 2.000 actualizaciones |
| Tarjetas | Clic en compartir, descarga y visita atribuida, por separado; «publicación confirmada» solo con evidencia del canal |

La ventana es la vigencia de cada reto. La retención D7/D30 y el incremento con grupo de control **no** están calculados todavía (§2, fila 8).

## 5. Pruebas

| Prueba | Qué cubre |
|---|---|
| `test/gamification_challenges.test.ts` | Flujo completo por la API; enlace opaco y revocable; métricas separadas; validaciones de juego responsable; exclusión y suspensión por señal de riesgo; reverso con asiento compensatorio; bono pendiente que se confirma al conciliar; aislamiento entre tenants; versión fijada; resincronización del tiempo real |
| `test/db_runtime.test.ts` (pruebas 8 y 9) | Retos, inscripciones, logros, alias, enlaces y el XP otorgado sobreviven al reinicio; un enlace revocado sigue revocado. XP y monedas (con reverso) sobreviven al reinicio, la otra réplica los recibe sin efectos, una referencia repetida no vuelve a sumar y la base rechaza un saldo negativo |
| `test/e2e/demo/gamification.spec.ts` | Backoffice y teléfono en el navegador: crear, enviar, aprobar, simular, inscribirse, progreso en vivo, logro, tarjeta con alias, confirmación antes de compartir, axe y 390 px |
| `test/gamification_gifts.test.ts` | Regalos: flujo completo por la API, asignación determinista con cupo, reclamación simultánea con un solo efecto, juego responsable al asignar y al reclamar, autor ≠ aprobador, bono pendiente que se confirma, vencimiento, cierre con revocación, aislamiento entre tenants |
| `test/e2e/demo/gifts.spec.ts` | Regalos en el navegador: crear, aprobar y entregar por rol, «Mis regalos», reclamar una vez, axe y 390 px |
| `test/gamification_tournaments.test.ts` | Torneos: reglas fijadas, inscripción voluntaria, eventos tardíos dentro y fuera del margen, cierre sin pagar, eventos después del cierre ignorados, reconstrucción con el mismo hash, aprobación por otra persona e idempotente. Clasificaciones: empates, paginación, fila propia, alias con permiso, nombre opaco, ocultarse, juego responsable, visibilidad por tabla, temporada y reto |
| `test/e2e/demo/leaderboards.spec.ts` | Clasificaciones en el navegador: pestaña paginada, fila propia en el teléfono sin ids, ocultarse, axe y 390 px |
| `test/e2e/stack/gamification_realtime.spec.ts` | Servidor real: SSE al momento, reanudación sin duplicados, aislamiento del canal por tenant, enlace público sin sesión con `noindex`, revocación |

## 6. Dependencias pendientes de SS1

- Alias público del jugador (N7 de la solicitud SS1-CRM-INT-01). Hoy el jugador lo define en el CRM.
- Ubicaciones, íconos de marca y textos aprobados para mostrar retos, logros y rankings en el sitio y la app.
- Eventos `player.activity` (perfil completado, secciones visitadas, preferencias) emitidos por el sitio.
- Servicio de bonos real con consulta por clave de idempotencia (N4/N5).
- Mecanismo de sorteo autorizado para concursos aleatorios.

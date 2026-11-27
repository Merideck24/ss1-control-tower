# Gamificación ampliada · SS1 CRM & Loyalty

**Estado al 27 de noviembre de 2026.** Se completaron los pendientes de la primera entrega, en este orden:

1. Libros de XP y monedas durables en PostgreSQL (migración 004).
2. Regalos instantáneos de punta a punta (migración 005).
3. Torneos ampliados y tablas de clasificación (migración 006).
4. Concursos con sorteo verificable o jurado.
5. Retención D7/D30 por cohorte y grupo de control por reto (migración 007).

La primera entrega fue el flujo completo:

> crear reto → aprobar → inscribir jugador sintético → recibir evento → actualizar progreso → confirmar recompensa → desbloquear logro → generar tarjeta compartible

Lo que sigue abierto está en la columna «Qué falta» de §2; lo que depende de SS1, en §6. Lo más importante: el **mecanismo de sorteo autorizado** (sin él, en producción no se aprueban ganadores de sorteos) y la **sincronización de la gamificación entre réplicas de la web** (hoy se carga al arrancar).

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
| 7 | Concursos | **Hecho** (el sorteo real depende de SS1) | Bases obligatorias (requisitos, fechas, premios, cómo se elige) firmadas al aprobar por otra persona. Requisitos sin compra: perfil completo o nivel de fidelidad; se rechaza cualquier requisito de depósito o apuesta y cualquier texto que invite a recuperar pérdidas. Participación aceptando las bases, una por jugador, con juego responsable. Revisión: descalificación con código (cuenta duplicada, incumple bases, no elegible, sospecha de fraude, contenido ofensivo) y motivo, reversible con motivo, todo auditado. Dos tipos: **sorteo** (mecanismo enchufable `DrawProvider`; compromiso de la semilla publicado al aprobar, semilla revelada al sortear, verificación reproducible en `GET /contests/:id/draw-proof`) y **jurado** (ganadores con motivación por puesto). Aprobación de ganadores por otra persona (ni quien creó ni quien eligió), que revalida juego responsable y política y entrega una sola vez. Cierre automático por fecha y cancelación con motivo. Resultado para el jugador con nombres públicos, sin ids. Pestaña «Concursos» y bloque en el teléfono. Persistencia (migración 005; la semilla solo en la base hasta el sorteo) | `test/gamification_contests.test.ts` (4), `test/db_runtime.test.ts` (concurso tras reinicio; el sorteo se verifica con la semilla persistida), `test/e2e/demo/contests.spec.ts` | **Mecanismo de sorteo autorizado** del mercado (certificado o ante notario): el de demostración no lo es y, en producción (`NODE_ENV=production`), no se aprueban ganadores de un sorteo hecho con él |
| 8 | Backoffice y Control Tower | **Parcial** | Pestañas «Regalos» (métricas por campaña), «Concursos» (revisión, sorteo, verificación y aprobación) y «Clasificaciones» (paginada, con ids internos y cómo lo ve el sitio). Torneos con cierre y aprobación de resultados en «Gamificación». Pestaña «Retos y logros»: métricas por reto con definiciones, filtro por estado, acciones por rol, formulario sin JSON, simulación, catálogo de logros y métricas de tarjetas. **Impacto por reto**: grupo de control estable configurable (0 a 50 %; el control no ve el reto ni puede inscribirse), exposición por intención de tratar, retención D7 y D30 de tratamiento contra control con IC 95 % y aviso de muestra insuficiente, y cohortes de participantes por semana de inscripción (`GET /challenges/:id/impact`, botón «Impacto»). Exposiciones persistidas (migración 007). Tarjeta en el Control Tower: inscritos, inicio, finalización, recompensas, duplicados suprimidos, retraso p95 e interacciones con tarjetas | `test/gamification_impact.test.ts`, `test/db_runtime.test.ts` (exposiciones tras reinicio), `test/e2e/demo/gamification.spec.ts` | Filtros por marca, mercado y fecha en la pestaña de retos (la API ya filtra por marca y mercado) |
| 9 | Arquitectura y controles | **Parcial** | Aislamiento por tenant en API, base (RLS), canal en vivo y enlaces. Identidad desde la sesión. Idempotencia por evento y período. Revalidación de política antes de cada incentivo. Bonos con reserva de presupuesto y conciliación. Auditoría de cada paso. Persistencia de retos, inscripciones, logros, alias, enlaces y métricas (migración 003). **Libros de XP y monedas durables** (migración 004): asiento único por referencia, saldo de monedas en la misma transacción con `balance >= 0` en la base, carga al arrancar y lectura de los asientos de la otra réplica en cada ciclo, sin efectos | `test/db_runtime.test.ts` (gamificación, libros, regalos, torneos, concursos y exposiciones tras reinicio; réplica que recibe los asientos), `test/gamification_challenges.test.ts` (aislamiento) | Sincronización de la gamificación entre réplicas de la web (hoy se carga al arrancar). Borradores de retos propuestos por el copiloto |
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

La ventana es la vigencia de cada reto.

| Métrica de impacto | Definición |
|---|---|
| Exposición | Primera vez que un jugador elegible queda expuesto al reto mientras está activo (lo ve o genera actividad). El grupo (tratamiento o control) es estable por jugador y reto |
| Retención Dn | Actividad propia (apuesta liquidada, depósito o actividad en el sitio) entre el día n y el n+7 desde la exposición (o desde la inscripción, en las cohortes de participantes). Solo cuenta quien ya cumplió n+7 días («maduro») |
| Incremento | Tasa del tratamiento − tasa del control, por intención de tratar (todos los expuestos, se inscriban o no), con IC 95 %. Fiable con al menos 30 jugadores maduros por grupo |
| Cohortes | Participantes agrupados por la semana ISO de inscripción, con su D7 y D30 |

Métricas de regalos, torneos y concursos: definiciones junto a cada tabla en el backoffice («Cómo se calculan estas cifras») y en la fila correspondiente de §2.

## 5. Pruebas

| Prueba | Qué cubre |
|---|---|
| `test/gamification_challenges.test.ts` | Flujo completo por la API; enlace opaco y revocable; métricas separadas; validaciones de juego responsable; exclusión y suspensión por señal de riesgo; reverso con asiento compensatorio; bono pendiente que se confirma al conciliar; aislamiento entre tenants; versión fijada; resincronización del tiempo real |
| `test/db_runtime.test.ts` (pruebas 8 a 13) | Retos, inscripciones, logros, alias, enlaces y el XP otorgado sobreviven al reinicio; un enlace revocado sigue revocado. XP y monedas (con reverso) sobreviven al reinicio, la otra réplica los recibe sin efectos, una referencia repetida no vuelve a sumar y la base rechaza un saldo negativo |
| `test/e2e/demo/gamification.spec.ts` | Backoffice y teléfono en el navegador: crear, enviar, aprobar, simular, inscribirse, progreso en vivo, logro, tarjeta con alias, confirmación antes de compartir, axe y 390 px |
| `test/gamification_gifts.test.ts` | Regalos: flujo completo por la API, asignación determinista con cupo, reclamación simultánea con un solo efecto, juego responsable al asignar y al reclamar, autor ≠ aprobador, bono pendiente que se confirma, vencimiento, cierre con revocación, aislamiento entre tenants |
| `test/e2e/demo/gifts.spec.ts` | Regalos en el navegador: crear, aprobar y entregar por rol, «Mis regalos», reclamar una vez, axe y 390 px |
| `test/gamification_tournaments.test.ts` | Torneos: reglas fijadas, inscripción voluntaria, eventos tardíos dentro y fuera del margen, cierre sin pagar, eventos después del cierre ignorados, reconstrucción con el mismo hash, aprobación por otra persona e idempotente. Clasificaciones: empates, paginación, fila propia, alias con permiso, nombre opaco, ocultarse, juego responsable, visibilidad por tabla, temporada y reto |
| `test/e2e/demo/leaderboards.spec.ts` | Clasificaciones en el navegador: pestaña paginada, fila propia en el teléfono sin ids, ocultarse, axe y 390 px |
| `test/gamification_contests.test.ts` | Concursos: sorteo de punta a punta con descalificación y restitución motivadas, señal de riesgo que saca del sorteo, verificación reproducible, aprobación por otra persona e idempotente; jurado con motivación; requisitos sin compra; cancelación; cierre por fecha; bloqueo en producción de un sorteo no autorizado; aislamiento |
| `test/e2e/demo/contests.spec.ts` | Concursos en el navegador: participar aceptando bases, descalificar con motivo, cerrar, sortear, verificar, aprobar ganadores por rol, resultado sin ids, axe y 390 px |
| `test/gamification_impact.test.ts` | Impacto: retención con jugadores maduros y ventana de 7 días; el control no ve el reto ni se inscribe; incremento D7 con IC 95 %; cohortes por semana; permiso de analítica |
| `test/e2e/stack/gamification_realtime.spec.ts` | Servidor real: SSE al momento, reanudación sin duplicados, aislamiento del canal por tenant, enlace público sin sesión con `noindex`, revocación |

## 6. Dependencias pendientes de SS1

- Alias público del jugador (N7 de la solicitud SS1-CRM-INT-01). Hoy el jugador lo define en el CRM.
- Ubicaciones, íconos de marca y textos aprobados para mostrar retos, logros y rankings en el sitio y la app.
- Eventos `player.activity` (perfil completado, secciones visitadas, preferencias) emitidos por el sitio.
- Servicio de bonos real con consulta por clave de idempotencia (N4/N5).
- Mecanismo de sorteo autorizado para concursos aleatorios (se conecta como `DrawProvider`; ver `src/gamification/contests.ts`). Sin él, en producción no se aprueban ganadores de sorteos.

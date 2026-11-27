# Gamificación ampliada · SS1 CRM & Loyalty

**Estado al 27 de noviembre de 2026.** Primera entrega funcional del alcance de gamificación de las fases 2 y 3. Primero se construyó el flujo completo que pedía el encargo:

> crear reto → aprobar → inscribir jugador sintético → recibir evento → actualizar progreso → confirmar recompensa → desbloquear logro → generar tarjeta compartible

Ese flujo funciona de punta a punta, en el backoffice y en el teléfono del jugador, con persistencia, permisos, auditoría y métricas. Regalos, concursos y la ampliación de torneos y rankings **siguen pendientes** (§2).

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
| 2 | Regalos instantáneos | **Pendiente** | Base reutilizable: catálogo con presupuesto y reserva, bandeja in-app, tienda con stock | — | Todo el módulo: regalos individuales o por segmento, «Mis regalos», estados, reclamación única concurrente, asignación determinista |
| 3 | Torneos | **Parcial** (fase anterior) | Torneos con clasificación del servidor, puntuación que ignora premios y descuenta reversiones, validación de premios | `test/games.test.ts` | Reglas versionadas y fijadas al iniciar, inscripción, eventos tardíos, cierre con conciliación y **aprobación de resultados** antes de repartir premios, reconstrucción del ranking desde eventos |
| 4 | Retos y misiones | **Hecho** | Retos diarios, semanales y de temporada. Modos individual, secuencial y de varios pasos. Pasos de ejemplo: completar perfil, explorar secciones, rondas de casino, apuestas deportivas, nivel de fidelidad. Inscripción voluntaria con preferencia de avisos y tope de 3 retos activos. Aprobación por otra persona con firma, versión fijada por inscripción, simulación sin efectos, pausa y cierre con motivo. Misiones de la fase anterior intactas | `test/gamification_challenges.test.ts` (7), `test/e2e/demo/gamification.spec.ts` | Plantillas de retos por mercado; programación recurrente automática de retos diarios |
| 5 | Tablas de clasificación | **Parcial** | Clasificación de torneos calculada en el servidor; alias público con permiso del jugador (ya disponible para rankings) | `test/games.test.ts` | Rankings por reto y por temporada, paginación, empates y desempates visibles, avatar, controles de visibilidad por ranking, actualización en vivo |
| 6 | Logros y compartir | **Hecho** | Catálogo de 4 logros con niveles y fecha. «Mis logros» en el perfil del jugador. Alias con permiso explícito para mostrarlo. Tarjeta SVG 1200×630 con la identidad de SS1, sin saldos, depósitos, apuestas ni datos personales. Descarga, Web Share API o copiar enlace, siempre con confirmación previa. Enlace público con id opaco de 22 caracteres, revocable y sin indexar. Métricas separadas: clic, descarga, visita atribuida y publicación confirmada (solo con evidencia del canal) | `test/gamification_challenges.test.ts`, `test/e2e/stack/gamification_realtime.spec.ts` (enlace público real, revocación) | Plantillas de tarjeta por marca (hoy usan los tokens SS1), evidencia de publicación desde cada red social (requiere integraciones) |
| 7 | Concursos | **Pendiente** | — | — | Todo el módulo: bases, requisitos, participaciones, revisión y descalificación motivada, aprobación de ganadores, interfaz para un sorteo autorizado |
| 8 | Backoffice y Control Tower | **Parcial** | Pestaña «Retos y logros»: métricas por reto con definiciones, filtro por estado, acciones por rol, formulario sin JSON, simulación, catálogo de logros y métricas de tarjetas. Tarjeta en el Control Tower: inscritos, inicio, finalización, recompensas, duplicados suprimidos, retraso p95 e interacciones con tarjetas | `test/e2e/demo/gamification.spec.ts` | Pantallas de Regalos, Torneos, Clasificaciones y Concursos. Filtros por marca, mercado y fecha en la pestaña (la API ya filtra por marca y mercado). Retención D7/D30 por cohorte de participantes. Grupo de control para medir el incremento de un reto |
| 9 | Arquitectura y controles | **Parcial** | Aislamiento por tenant en API, base (RLS), canal en vivo y enlaces. Identidad desde la sesión. Idempotencia por evento y período. Revalidación de política antes de cada incentivo. Bonos con reserva de presupuesto y conciliación. Auditoría de cada paso. Persistencia de retos, inscripciones, logros, alias, enlaces y métricas (migración 003) | `test/db_runtime.test.ts` (gamificación tras reinicio), `test/gamification_challenges.test.ts` (aislamiento) | El **libro de fidelidad (XP) y el de monedas siguen en memoria**: tras reiniciar sin base de eventos completa, el saldo de XP otorgado por retos no se conserva (el estado del reto sí). Sincronización de la gamificación entre réplicas de la web (hoy se carga al arrancar). Borradores de retos propuestos por el copiloto |
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
| `test/db_runtime.test.ts` (prueba 8) | Retos, inscripciones, logros, alias y enlaces sobreviven al reinicio con PostgreSQL; un enlace revocado sigue revocado |
| `test/e2e/demo/gamification.spec.ts` | Backoffice y teléfono en el navegador: crear, enviar, aprobar, simular, inscribirse, progreso en vivo, logro, tarjeta con alias, confirmación antes de compartir, axe y 390 px |
| `test/e2e/stack/gamification_realtime.spec.ts` | Servidor real: SSE al momento, reanudación sin duplicados, aislamiento del canal por tenant, enlace público sin sesión con `noindex`, revocación |

## 6. Dependencias pendientes de SS1

- Alias público del jugador (N7 de la solicitud SS1-CRM-INT-01). Hoy el jugador lo define en el CRM.
- Ubicaciones, íconos de marca y textos aprobados para mostrar retos, logros y rankings en el sitio y la app.
- Eventos `player.activity` (perfil completado, secciones visitadas, preferencias) emitidos por el sitio.
- Servicio de bonos real con consulta por clave de idempotencia (N4/N5).
- Mecanismo de sorteo autorizado para concursos aleatorios.

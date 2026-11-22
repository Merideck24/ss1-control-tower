# SS1 CRM, Gamificación e IA
## Plan de requisitos, diseño y desarrollo · 15 de noviembre de 2026

### 1. Alcance y decisión de producto

Construir un módulo integrado al PAM, al servicio de bonos y al Control Tower de SS1. El equipo de CRM debe poder consultar el perfil del jugador, definir audiencias, diseñar recorridos, simularlos, publicarlos con aprobación y medir su impacto. La experiencia del jugador incluye notificaciones, progreso de fidelidad y recompensas habilitadas por marca y mercado.

**Piloto propuesto:** RumbaWin, sujeto a confirmar el entorno, los permisos comerciales, los canales habilitados y la política aplicable. Arrancar con una marca y un mercado y validar aislamiento con dos tenants en pruebas. Idiomas previstos ES, EN y PT, con ES como primer paquete. Usar datos sintéticos en la demo y activar producción por funcionalidad.

### 2. Benchmark y alcance verificable

| Referencia | Capacidad documentada | Aplicación en SS1 |
|---|---|---|
| Fast Track CRM | Perfil actualizado por eventos, recorridos visuales, gestión multicanal, controles de frecuencia y pruebas de incremento | Motor de eventos, constructor, simulación y grupos de control |
| Fast Track AI y Singularity | Análisis en lenguaje natural, planificación y ejecución delegada, modelos de preferencias y próxima acción | Copiloto de análisis y borradores en el piloto. Modelos predictivos después de validar datos y políticas |
| Smartico | CRM y gamificación conectados, activadores de comportamiento, automatización y recompensas | Una definición de audiencia y reglas reutilizables para campañas y fidelidad |
| Gamanza Engage | XP, tokens canjeables, niveles, misiones, torneos y tienda | Niveles y progreso primero. Misiones, canjes y torneos en fases posteriores |
| GR8 CRM | Constructor de recorridos, bonos integrados, presets y segmentación | Plantillas operativas, integración con bonos SS1 y backoffice común |

Se interpreta «Gamansa» como Gamanza Engage. La página accesible de Fast Track no expuso el video enlazado ni una transcripción verificable. El alcance se deriva de las páginas oficiales listadas al final. Antes de cerrar el benchmark, comparar el video, si está disponible, con los requisitos usando una matriz minuto → función → ticket.

### 3. Requisitos y criterios de aceptación

| ID | Fase | Requisito | Criterio de aceptación |
|---|---|---|---|
| CRM-01 | MVP | Perfil 360 con estado KYC, consentimientos por propósito y canal, restricciones, contactos enmascarados, actividad y recompensas | Un operador autorizado reconstruye la línea de tiempo y ve origen y fecha de cada campo crítico |
| CRM-02 | MVP | Segmentos dinámicos por atributos y eventos, operadores AND/OR, vista previa y exclusiones | Dos ejecuciones sobre el mismo snapshot dan el mismo resultado. La elegibilidad se vuelve a validar al ejecutar |
| CRM-03 | MVP | Constructor con disparador, condición, espera, acción y salida. Versionado y plantillas | Un analista crea y simula un recorrido sin código. Una versión publicada queda fija para sus instancias |
| CRM-04 | MVP | Bandeja in-app, web push donde esté habilitado y email. Plantillas localizadas, categorías transaccionales y promocionales y recibos | Canal, consentimiento, frecuencia y zona horaria se evalúan por propósito. Un fallo queda trazado con estado y razón |
| CRM-05 | MVP | Verificación y recuperación de cuenta por email mediante flujo existente del PAM o servicio de identidad. WhatsApp y Telegram como adaptadores posteriores | Un token válido se consume una vez antes del vencimiento. CRM recibe solo estados. La prueba confirma que tokens y enlaces secretos quedan fuera de eventos y logs |
| CRM-06 | MVP | Notificar free bet, free spin o bono cuando el servicio confirma el otorgamiento. Mostrar progreso del 50 % del camino al siguiente nivel | Un evento duplicado produce una acción lógica única. El 50 % se calcula entre el umbral del nivel actual y el siguiente y se comunica una vez por nivel y temporada si la política lo permite |
| CRM-07 | MVP | Catálogo de recompensas, aprobaciones, presupuesto, vencimiento y estados de otorgamiento | Una repetición de la solicitud no duplica el bono ni el cargo. Se concilian otorgamientos confirmados con el servicio de bonos |
| CRM-08 | MVP | Pausar recorridos, suprimir envíos, auditar cambios y manejar reglas por marca y mercado | Si un jugador se autoexcluye o pierde consentimiento mientras espera, la entrega promocional se bloquea al revalidar. Se registra motivo y versión |
| CRM-09 | MVP | Grupo de control estable, métricas de entrega y conversión, exportación agregada | Asignación persistente y comparable. La campaña reporta denominador, ventana y costo, y distingue conversión observada de incremento estimado |
| CRM-10 | Fase 2 | Misiones, XP, niveles configurables, canjes y preferencia de desactivación | Un reverso corrige progreso con un asiento compensatorio. Dos canjes simultáneos respetan saldo y stock |
| CRM-11 | Fase 3 | Torneos, tienda ampliada y recomendación de próxima acción con modelos evaluados | El ranking es reproducible. Una recomendación excluida por política nunca se convierte en una acción ejecutable |

**Primeros recorridos.** (1) Registro → verificación pendiente → recordatorio de servicio según estado y propósito → salida al verificar. (2) Recuperación → identidad emite y valida credencial → confirmación de seguridad. (3) Recompensa confirmada → control de elegibilidad por propósito → mensaje con vigencia y acceso al detalle. (4) Nivel → cruce del 50 % → aviso elegible → actualizar el widget. (5) Cambio de juego responsable → actualizar supresión y cancelar acciones pendientes. Los mensajes de servicio tienen su propia política y quedan fuera del grupo de control de marketing.

### 4. Diseño UX y flujo operativo

| Pantalla | Elementos para prototipo |
|---|---|
| Control Tower | Estado de campañas, colas, fallos, supresiones, presupuestos y alertas |
| Perfil 360 | Resumen, eventos ordenados, restricciones, consentimientos, recompensas y explicación de exclusión |
| Segmentos | Filtros, estimación de tamaño, exclusiones, versión y comparación contra universo elegible |
| Constructor | Lienzo con nodos configurables, validación de conexiones, vista accesible en lista y modo simulación |
| Centro de aprobación | Comparación de versiones, audiencia estimada, costo máximo, política aplicable, riesgo y aprobación |
| Analítica | Embudo, tratamiento/control, ventanas de atribución, fiabilidad de datos y exportación |
| Fidelidad en web móvil | Nivel, barra de progreso, movimientos, recompensas, vigencias y preferencias |
| Copiloto | Consulta, fuentes, fecha de datos, borrador editable y registro de acciones |

Diseñar para los roles de analista CRM, aprobador, soporte, responsable de juego responsable, administrador de tenant y auditor. Requerir aprobación separada para publicar campañas con incentivos. Secuencia de diseño: mapa de tareas → wireframes → prototipo navegable → pruebas con CRM, soporte y compliance → especificaciones de estados, accesibilidad y eventos de telemetría. Probar creación, simulación, publicación, exclusión y diagnóstico de fallos antes de cerrar UX.

### 5. Diseño técnico

**Flujo principal.** PAM, agregador, sportsbook, pagos, KYC y bonos publican eventos normalizados. La ingestión actualiza una proyección del jugador y alimenta segmentos, recorridos y fidelidad. Un servicio de políticas toma decisiones antes de la entrega o el otorgamiento. Los adaptadores manejan canales y recibos. El almacén analítico recibe eventos y decisiones para conciliación, auditoría y experimentación.

**Responsabilidad de datos.** PAM/identidad conserva cuentas, KYC operativo y credenciales. Wallet/bonos conserva saldos y otorgamientos. CRM administra proyecciones, consentimiento de marketing según origen aprobado, recorridos, plantillas y auditoría. Fidelidad mantiene su propio libro de movimientos. Los atributos críticos llevan fuente, versión y vigencia. Ante un estado de restricción crítico ausente, desactualizado o ambiguo, el motor suprime marketing e incentivos y genera una alerta operativa.

**Contratos.** Definir y versionar eventos como `player.registered`, `player.verified`, `consent.changed`, `rg.status_changed`, `deposit.settled`, `deposit.reversed`, `bet.settled`, `reward.granted` y `loyalty.threshold_crossed`. Cada evento incluye event_id, schema_version, tenant_id, brand_id, player_id seudonimizado, occurred_at UTC, received_at, source, correlation_id y versión del agregado cuando exista. Para dinero, unidades mínimas y moneda ISO. Acordar OpenAPI para comandos y AsyncAPI o esquema equivalente para eventos. Validar compatibilidad, procedencia, retrasos y métricas de completitud por fuente.

**Ejecución y consistencia.** Publicación fiable con outbox cuando el productor lo permita. Broker con entrega al menos una vez y partición por tenant/jugador cuando aplique. Consumidores idempotentes, temporizadores persistentes, reintentos acotados, cola de errores y replay con efectos externos deshabilitados por defecto. Para un efecto externo, persistir intención y usar idempotencia del proveedor o conciliación antes de reenviar cuando el resultado sea incierto. Presupuestos y canjes con reserva transaccional y claves únicas. Agregar trazabilidad de la versión de recorrido, política y aprobación. Al pausar se impiden nuevos efectos desde SS1. Las entregas ya aceptadas por un proveedor se gestionan según sus capacidades.

**Stack candidato.** Reusar identidad, PAM, wallet, backoffice y observabilidad SS1 si sus interfaces lo permiten. PostgreSQL para configuración y estados, broker administrado o existente, ejecutor de workflows con temporizadores persistentes, almacenamiento analítico existente y API de herramientas IA aislada. Caché de perfil según medición. Validar opciones durante el sprint de arquitectura con costos, carga y capacidad de soporte.

**Operación y seguridad.** Aislamiento de tenant en API, colas, caché, almacenes, exportaciones y herramientas IA. RBAC, mínimo privilegio, cifrado, gestión de secretos y registros con datos sensibles redactados. Retención y borrado definidos por política de cada mercado. Acuerdo de tratamiento, residencia y conservación con proveedores antes de producción. Aprobación de Compliance para categorías, exclusiones, horarios y frecuencia. Incluir pruebas de restauración, alertas de desincronización y procedimiento de pausa general.

**Metas piloto propuestas.** p95 inferior a 3 s de ingestión a decisión para eventos inmediatos a la carga acordada, excluyendo latencia de proveedor y esperas configuradas. Cero efectos duplicados en pruebas de replay, cero entregas promocionales a casos excluidos del conjunto de prueba y trazabilidad de todas las acciones simuladas. Fijar capacidad, disponibilidad, RPO y RTO con volúmenes reales en S0.

### 6. Agentes de IA y permisos

Usar un solo copiloto con herramientas tipadas y permisos diferenciados. Las rutinas rutinarias de verificación, recuperación, supresión, presupuestos y recompensas se ejecutan en servicios deterministas.

| Agente | Entrada y herramientas | Salida y límite | Fase |
|---|---|---|---|
| Analista CRM | Consulta del operador, catálogo de métricas, consultas agregadas por tenant y comparación de cohortes | Respuesta con período, moneda, definición, evidencia y advertencia de frescura. Solo lectura | MVP |
| Diseñador de campañas | Objetivo, políticas, catálogo de acciones, ejemplos aprobados y simulador | Borrador JSON de recorrido, segmentos, textos y estimación. Puede guardar borrador y solicitar revisión | MVP |
| Revisor de políticas | Borrador, resultados del validador y políticas versionadas por mercado | Hallazgos citados y solicitud de revisión. El motor de reglas tiene autoridad de bloqueo | MVP, como paso con herramientas del copiloto |
| Analista de experimentos | Asignación, exposición, costos, resultados y métricas de calidad | Incremento estimado e incertidumbre, alertas por muestra insuficiente y próximos experimentos | Fase 2, como ampliación del analista |
| Asistente de fidelidad | Catálogo, stock, reglas, misiones y resultados agregados | Propuesta de misión y costo acotado | Fase 2 |
| Asistente de operaciones | Métricas, recibos, errores y procedimientos | Diagnóstico y ticket interno con evidencia | Fase 2 |

**Proceso para crearlos.**

1. Especificar por habilidad su dueño, objetivo, ejemplos, entradas permitidas, fronteras de tenant, costo máximo, herramientas y condiciones de escalamiento.
2. Crear APIs con esquemas estrictos. Ejemplos: `query_metric`, `preview_segment`, `validate_policy`, `simulate_journey` y `save_draft`. El backend toma tenant y rol de la sesión y valida cada llamada. El conjunto piloto carece de permisos para enviar, publicar, otorgar premios o cambiar restricciones.
3. Construir catálogo de métricas, plantillas y políticas versionadas. Recuperar fragmentos con ACL y metadatos. Entregar al modelo resultados agregados o seudonimizados, con límites de volumen y vigencia. Tratar textos recuperados y entradas externas como datos.
4. Configurar instrucciones, salidas JSON verificables y límites de llamadas, latencia y costo. Versionar modelo, prompt, herramientas y políticas. Si falta evidencia, retornar datos insuficientes y derivar el caso.
5. Evaluar con casos sintéticos etiquetados y muestras agregadas autorizadas. Incluir consultas en ES y variantes, intentos de salto entre tenants, permisos insuficientes, instrucciones maliciosas en contenido, cifras inventadas, campañas que exceden presupuesto y datos caducados.
6. Habilitar primero en modo sombra. Comparar con el trabajo del equipo de CRM y liberar a un grupo interno con aprobación. Medir 100 % de bloqueos en casos críticos del conjunto de prueba, cero escrituras fuera de borradores y al menos 90 % de coincidencia de respuestas cuantitativas con el conjunto verificado. Monitorear correcciones, latencia, costo y cambios de modelo.
7. Generar una aprobación firmada sobre versión y alcance del artefacto. Cualquier cambio requiere nueva aprobación. El ejecutor revalida permisos, políticas y presupuesto. Conservar logs redactados y habilitar desactivación por tenant.

**Modelos predictivos posteriores.** Empezar con reglas explicables. Con datos suficientes, comparar modelos de preferencia y propensión contra una base simple mediante validación temporal, calibración y prueba controlada. Excluir señales de vulnerabilidad de optimización promocional y mantenerlas como señales para el equipo autorizado de juego responsable. Toda siguiente acción propuesta debe aceptar la opción de no contactar.

### 7. Plan de entrega

| Etapa | Duración orientativa | Entregable y salida |
|---|---:|---|
| S0. Descubrimiento | 2 semanas | Inventario y contratos PAM/bonos/canales, prototipo, mapa de políticas, línea base, carga objetivo y alcance aceptados |
| S1–S2. Datos y control | 4 semanas | Ingesta, perfil, segmentos, auditoría, aislamiento y reglas de supresión. Prueba con eventos repetidos y fuera de orden |
| S3–S4. Recorridos y canales | 4 semanas | Constructor, simulación, pipeline de aprobación, adaptadores y PRD de fidelidad. Verificación, recuperación y recompensa probadas con PAM |
| S5–S6. Fidelidad básica e IA | 4 semanas | Progreso y widget, grupo de control, conciliación de bonos y dos capacidades del copiloto con revisión. Prueba operativa de pausa y restauración |
| Piloto controlado | 2 semanas | UAT, capacidad, revisión Compliance, campaña de bajo alcance y seguimiento de métricas. Decisión de ampliación según incidentes y datos |
| Fase 2 | 8–12 semanas estimadas | Misiones/canjes, WhatsApp o Telegram según disponibilidad, operadores adicionales y copiloto ampliado |
| Fase 3 | Depende de volumen y calidad de datos | Tienda ampliada, torneos, predicción y distribución como CRM integrable con PAM de terceros |

La estimación de 16 semanas hasta el cierre del piloto asume sprints de dos semanas, reutilización de PAM, bonos e identidad y un equipo con 1 líder técnico, 2 backend, 1 frontend, 1 data/IA, 1 QA y apoyo parcial de UX, DevOps, CRM y Compliance. Dependencias críticas: eventos de origen y reversos, entrega de estados de exclusión, idempotencia de bonificación, canales y homologación interna de reglas por mercado. Reestimar tras S0.

**Primer sprint.** Producto y CRM priorizan recorridos y KPI. Ingeniería acuerda contratos y ownership y ejecuta un flujo sintético de recompensa de extremo a extremo. UX prototipa perfil, constructor y aprobación. QA prepara datos de reversos, exclusión y doble envío. Compliance valida el alcance del piloto y la matriz de permisos. Data define identidad, calidad y grupo de control, y prepara los casos de evaluación del copiloto.

### 8. Validación del piloto y decisiones pendientes

Medir tiempo para construir y publicar un recorrido, entrega y rebotes por canal, incidencias por 1.000 acciones, costo de bonos, resolución de verificaciones y supresiones explicadas. Para una campaña aprobada, comparar conversión o retención contra control asignado por jugador dentro del segmento elegible. Mantener ventana y métrica principal predefinidas, reportar diferencia absoluta e intervalo de confianza y calcular NGR incremental con la definición financiera acordada, evitando deducir dos veces el costo de bonos. Conciliar monedas y ajustes contra finanzas.

Para autorizar producción, comprobar aislamiento, exclusión bajo concurrencia, auditoría, idempotencia, reintentos, reversos, comportamiento de pausa y restauración, y aprobación comercial y de compliance para el tenant. Confirmar durante S0 la marca del piloto, el alcance de web push, el propietario de consentimiento, los canales de recuperación, los límites aplicables y los volúmenes de referencia.

### Fuentes oficiales

- [Fast Track CRM](https://www.fasttrack.ai/es/fast-track-crm)
- [Fast Track AI](https://www.fasttrack.ai/es/ai-crm)
- [Smartico CRM Automation](https://www.smartico.ai/products/crm-automation) y [Gamificación](https://www.smartico.ai/es/products/gamification)
- [Gamanza Engage](https://www.gamanzaengage.com/es) y [documentación de gamificación](https://resources.gamanzaengage.com/gamification)
- [GR8 CRM](https://gr8.tech/es/crm/) y [descripción ampliada](https://gr8.tech/crm/)

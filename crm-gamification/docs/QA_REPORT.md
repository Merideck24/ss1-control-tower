# Informe de QA · SS1 Control Tower

**Fecha:** 2026-11-26 · **Código:** rama `main` (la demo publicada en GitHub Pages es byte a byte el build de `main`: sha256 `3f691a1f…` antes de este incremento) · **Datos:** sintéticos.

> **Alcance de la evaluación.** Todo lo de este informe es **autoevaluación**: pruebas automáticas, recorridos guiados en Chromium y revisión de accesibilidad con axe-core 4.10.2. No hubo sesiones con usuarios reales de SS1 (operadores de CRM, aprobadores, Compliance) ni acceso al PAM real: la credencial de SS1 no está disponible. Las conclusiones de UX son hipótesis a validar con tareas reales.

## 1. Qué sirve qué

| Pieza | Código | Cómo corre |
|---|---|---|
| Demo publicada | `public/index.html` + `src/browser.ts`, empaquetados por `scripts/build-static.mjs` en `dist/index.html` | GitHub Pages, workflow `.github/workflows/crm-pages.yml` desde `main`. El dominio completo corre en el navegador: `fetch('/api/…')` se resuelve con el mismo `router.ts`. |
| Backend local | `src/api/server.ts` → `src/api/router.ts` | `npm start` (auth de desarrollo) o `npm run start:prod` (token del admin de SS1) |
| Kit para el admin de SS1 | `integrations/ss1-admin/` (Vue/Vuexy) | Se monta en `/dashboard/crm` del admin |

**Supuesto registrado.** El encargo menciona un proyecto Next.js, `SS1_Plan_CRM_Gamificacion_IA.md` y `CONTINUIDAD.md`, que no existen en este repositorio. Se trabajó sobre el código real (Node 22 + TypeScript, interfaz en HTML y JS) y se creó [`CONTINUIDAD.md`](../CONTINUIDAD.md).

## 2. Línea base y resultado

| Verificación | Antes | Después |
|---|---|---|
| `npm test` | 159 ✔ · 0 ✘ · 4 omitidas (PostgreSQL) | **171 ✔ · 0 ✘ · 4 omitidas** |
| `npm run typecheck` (CRM + kit Vue) | limpio | limpio |
| Barrido de robustez: cada operación con datos vacíos o mal formados | 86 operaciones, 0 respuestas 5xx | **87 operaciones, 0 respuestas 5xx** |
| Hallazgos de UX previos (`findings.cjs`) | 20/20 | 20/20 |
| Los 3 hallazgos conocidos (`a11y.cjs`) | 16/16 | 16/16 |
| Formularios (`formtest.cjs`) | 29/29 | 29/29 |
| Seguimiento y cierre en el Constructor (`closeui.cjs`, nuevo) | — | 5/5 |
| axe-core en las pantallas tocadas | 0 violaciones | 0 violaciones, escritorio y 390 px |

### Los tres hallazgos conocidos

Se corrigieron en `cf65b32` y se volvieron a verificar hoy; los 16 controles pasan.

1. **Selectores de jugador sin nombre accesible.** Hay 9 selectores y cada uno se llama «Jugador para simular «<recorrido>»». axe no encuentra violaciones de `select-name`.
2. **Controles anidados en el lienzo.** Quedan 0 controles anidados. El paso es un `<button>` y las salidas son sus hermanas. Con teclado: Enter selecciona, Tab llega a la salida, Espacio conecta y Escape cancela, y el foco se mantiene.
3. **«Aceptado» frente a «Entregado».** El total dice «Envíos aceptados», y el desglose y Analítica dicen «Aceptado(s)», también en el widget del kit.

## 3. Defectos encontrados y corregidos en este incremento

| ID | Módulo | Defecto | Prioridad | Corrección | Evidencia |
|---|---|---|---|---|---|
| D-01 | Constructor / Registro | Publicar la v2 de un recorrido con la v1 publicada respondía **500**, porque la v1 está congelada y el código intentaba modificarla | P0 | `src/journeys/registry.ts` reemplaza la versión por su copia archivada en vez de modificarla | `test/constructor_lifecycle.test.ts` paso 6; sin la corrección falla con `Cannot assign to read only property 'status'` |
| D-02 | Runtime | **Versión fijada rota**: al publicar una versión nueva, las instancias de la anterior quedaban esperando para siempre y el mensaje nunca salía | P0 | `src/journeys/runtime.ts`: una versión `archived` deja terminar a quien ya entró (`RUNNABLE`) | Mismo test: p1 termina en v1 y recibe su mensaje; v2 atiende las entradas nuevas |
| D-03 | Constructor | El ciclo no tenía **cierre**: solo existían pausar y reanudar | P1 | `POST /journeys/:id/close`: exige motivo, solo `tenant_admin`, `approver` o `rg_officer`, cierra todas las versiones; las instancias salen con `journey_closed`; queda en auditoría. Botón «Cerrar…» en la interfaz | Test paso 7 (403 para el analista, 422 sin motivo, salida explicada, no se reanuda); `closeui.cjs` U.1, U.3 y U.4 |
| D-04 | Constructor | Sin **seguimiento** por recorrido: no se veía cuántos están en cada estado y versión, ni por qué se suprimió | P1 | `GET /journeys/:id/runs`: instancias por estado y versión, envíos, supresiones por motivo y fallas. Botón «Seguimiento» | Test pasos 4–7; `closeui.cjs` U.2 |
| D-05 | Perfil 360 | No mostraba la etapa del jugador, los pendientes ni la **próxima acción permitida** | P1 | `src/profile/journeyState.ts`, derivado de las decisiones de política, que nunca contradice; tarjeta «Estado y próxima acción» | 400 jugadores clasificados sin errores (§5); `test/journey_state.test.ts` |
| D-06 | Perfil 360 | El panel de detalle, más alto ahora, se desplazaba pero no recibía foco de teclado (axe `scrollable-region-focusable`). Se detectó antes de publicar | P2 | `#pdetail` con `tabindex="0"` | axe: 0 violaciones |
| D-07 | Integración PAM | Los conectores dependían del cliente HTTP concreto: no se podía cambiar de adaptador ni probar el contrato sin red | P1 | Interfaz `PamSource` y `SandboxPam` en `src/integration/pam.ts` | `test/pam_contract.test.ts`: 6 pruebas, la misma suite para los dos adaptadores |

## 4. Matriz por módulo

Estados: ✅ conforme · 🔧 corregido en este incremento · ⏳ depende de SS1 · ⚠️ limitación conocida.

| Módulo | Funcionalidad | Actor | Resultado esperado | Observado | Defecto | Prioridad | Dependencia | Evidencia |
|---|---|---|---|---|---|---|---|---|
| Control Tower | KPIs, embudo, alertas, pausa general | Analista, admin | Cifras reproducibles por día; la pausa general detiene los envíos | ✅ | — | — | — | `findings.cjs`, `ux_findings.test.ts` |
| Perfil 360 | Búsqueda, ficha con procedencia, elegibilidad explicada | Analista, soporte | Cada dato con fuente, fecha y versión; motivo de cada bloqueo | ✅ | — | — | — | `crm01_profile_ingestion.test.ts` |
| Perfil 360 | Etapa, pendientes y próxima acción permitida | Analista, soporte | La acción respeta la política (JR → solo servicio) | 🔧 | D-05, D-06 | P1 | — | `journey_state.test.ts`, `jstate.cjs` |
| Segmentos | Constructor de reglas, vista previa, exclusiones | Analista | Formulario ⇄ JSON, determinista | ✅ | — | — | — | `formtest.cjs` S.1–S.10, `crm02_segments.test.ts` |
| Constructor | Borrador, revisión en vivo, simulación sin efectos | Analista | Validación y simulación que no envía | ✅ | — | — | — | `constructor_lifecycle.test.ts` pasos 1–2, `journey_builder.test.ts` |
| Constructor | Envío → aprobación (autor ≠ aprobador) → publicación firmada | Analista, aprobador | 403 al aprobar lo propio; no se publica sin aprobación | ✅ | — | — | — | Test paso 3, `crm03_journeys.test.ts` |
| Constructor | Ejecución con versión fijada al republicar | Sistema | Quien entró en v1 termina en v1 | 🔧 | D-01, D-02 | P0 | — | Test paso 6 |
| Constructor | Pausa y reanudación | Analista, admin | Sin entradas nuevas; las esperas no avanzan | ✅ | — | — | — | Test paso 5 |
| Constructor | Seguimiento y cierre | Analista (ver), admin (cerrar) | Conteos y motivos; cierre con motivo y salida explicada | 🔧 | D-03, D-04 | P1 | — | Test pasos 4 y 7, `closeui.cjs` |
| Aprobación | Cola por rol, estado vacío | Aprobador | Solo lo pendiente; nada aprobable por su autor | ✅ | — | — | — | `api_permissions.test.ts` |
| Políticas | Consentimiento, JR fail-closed, KYC para incentivos, topes 2/día y 5/semana, horario silencioso | Sistema, Compliance | Revalidación antes de cada efecto; supresión con motivo | ✅ | — | — | — | `crm04_08_policy.test.ts`, `overlap_frequency.test.ts` |
| Canales | Envío idempotente, reintentos acotados, recibos | Sistema | Nunca envía con variables vacías; las fallas quedan con motivo | ✅ | — | — | Proveedores reales: ⏳ | `channels_inbox.test.ts` |
| Recompensas | Presupuesto, idempotencia, conciliación | Sistema, admin | Sin doble otorgamiento; un resultado incierto se concilia | ✅ | — | — | Servicio de bonos real: ⏳ | `crm06_07_rewards_loyalty.test.ts` |
| Gamificación | Misiones, torneos, ruleta, tienda, predicciones | Analista, jugador | Apuesta = monto > 0; rollback compensa sin negativos | ✅ | — | — | — | `e2e_player_lifecycle.test.ts`, `games.test.ts` |
| Fidelidad | Niveles, aviso al 50 %, felicitación de nivel dentro de los topes | Jugador | Tope alcanzado → suprimido con motivo, sin reenvío | ✅ | — | — | — | `e2e_player_lifecycle.test.ts` |
| Analítica | Campañas, grupo de control, IC 95 % | Analista | Sin control → incremento nulo, no inventado | ✅ | — | — | — | `crm09_experiments.test.ts` |
| Juego responsable | Cola de riesgo, cancelación de marketing pendiente | Oficial de JR | Un cambio de JR cancela las esperas de marketing | ✅ | — | — | Feed JR real: ⏳ | `rg_risk.test.ts` |
| Copiloto | Herramientas tipadas con formularios | Analista | Sin herramientas para enviar, publicar ni otorgar | ✅ | — | — | Credencial Anthropic en el servidor para lenguaje natural | `copilot.test.ts`, `formtest.cjs` C.1–C.6 |
| Auditoría | Registro encadenado por hash | Auditor | Cada paso del ciclo auditado | ✅ | — | — | — | Test paso 7 (7 acciones) |
| Integración PAM | Conectores, mapeo de IDs, idempotencia, auth | Sistema | Misma suite para cualquier adaptador; solo lectura | 🔧 | D-07 | P1 | Credencial y filas reales: ⏳ | `pam_contract.test.ts` |
| Identidad SS1 | Sesión del admin → tenant y rol | Operador | Tenant y rol desde la sesión | ⏳ | — | P1 | `GET /admin/auth/me` (SS1) | `ss1_contract.test.ts` |
| Exportaciones | CSV de segmentos, auditoría y recibos | Analista, auditor | CSV válido, datos enmascarados | ✅ | — | — | — | `csv_brand_latency.test.ts` |
| Persistencia | PostgreSQL con RLS | Plataforma | Mismo comportamiento que en memoria | ⚠️ La demo usa memoria; PostgreSQL probado aparte | — | P2 | Base de datos del entorno | `db_postgres.test.ts` (4 omitidas sin base) |

## 5. Recorrido del jugador

Registro → verificación → primer depósito → activación → recompensas → fidelidad → soporte → juego responsable → baja. Se cubre en dos niveles:

- **Dominio:** `test/e2e_player_lifecycle.test.ts` lleva a un jugador de registro a fidelidad con misiones, nivel y topes, y `test/journey_state.test.ts` cubre cada etapa y acción.
- **Datos de la demo:** 400 jugadores clasificados por etapa y próxima acción, sin errores:

| Etapa actual → próxima acción | Jugadores |
|---|---|
| primer depósito → Invitar al primer depósito | 184 |
| fidelidad → Mantener (misión o torneo) | 85 |
| verificación → Recordar la verificación (sin incentivo) | 57 |
| fidelidad → Avisar cercanía a Plata u Oro | 33 |
| recompensas → Mantener, o avisar cercanía a Plata | 20 |
| baja (autoexcluido) → Solo servicio y JR | 14 |
| varias → No contactar por marketing (sin consentimiento o tope alcanzado) | 7 |

«Soporte» aparece como **sin fuente**: el PAM aún no expone casos de soporte.

## 6. Controles de automatización

| Control | Dónde |
|---|---|
| Borrador → simulación → revisión → aprobación → publicación → ejecución → seguimiento → pausa o cierre | Registro y runtime; `constructor_lifecycle.test.ts` |
| Idempotencia | `event_id` determinista en la ingesta, llave `instancia:nodo` en envíos y premios |
| Reintentos | Canales (acotados), cliente SS1 (exponencial con `Retry-After`; 401 y 403 no se reintentan) |
| Cola de fallas | Ingesta: `dead_letters`. Entregas: recibos `failed` con motivo en el Control Tower. Por recorrido: `failures` en Seguimiento |
| Revalidación antes de ejecutar | La política se decide en cada mensaje y premio, también al despertar de una espera o de un aplazamiento |
| Supresiones explicadas | Motivo en el recibo, en la auditoría (`delivery.suppressed`), en Seguimiento y en Perfil 360 |

## 7. Prioridades del siguiente incremento

1. **Prueba de contrato con datos reales de SS1** (P0, depende de SS1): correr `pam_contract.test.ts` con filas anonimizadas del sandbox. Es la puerta de la fase Sandbox → Piloto.
2. **Pantalla de cola de fallas con reproceso** (P1): hoy las fallas se ven, pero el reintento manual solo existe por API.
3. **Instancias y recibos en PostgreSQL** (P1): el runtime aún guarda en memoria.
4. **Pruebas con usuarios** (P1): 5 tareas con operadores de SS1, como crear y aprobar un recorrido o explicar por qué un jugador no recibe marketing, para validar esta autoevaluación.
5. **Fuente de soporte y campos de jugador** (P2, depende de SS1): email, idioma, zona horaria, afiliado y consentimiento.

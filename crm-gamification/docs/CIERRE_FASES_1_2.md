# Cierre de Fase 1 y Fase 2 · SS1 Control Tower

**Fecha:** 2026-11-26 · **Versión probada:** ver §5 (último commit con CI verde) (rama `main` = `feature/crm-gamification`) · **Datos:** sintéticos.

Estados:
- **Verificado:** probado y conforme.
- **Corregido:** había un defecto, se corrigió y la prueba lo cubre.
- **Solo demo:** funciona en la demo publicada, pero no existe o no aplica en el backend.
- **Bloqueado:** depende de algo que no controla este equipo; se nombra a quién le toca.

## 1. Entornos

| Entorno | Revisión | Qué corre | Cómo se comprobó |
|---|---|---|---|
| Demo publicada (GitHub Pages) | build estático de `main` | Todo el dominio en el navegador, datos sintéticos, sin servidor ni PostgreSQL | El sha256 de la página publicada coincidía con el build local de `85ee116` al empezar; el workflow de Pages publica cada push a `main` |
| Backend local | `main` | `npm start` (proceso único), o `CRM_ROLE=web npm start` más `npm run worker` | Prueba de humo y suite `stack` |
| CI | cada push y pull request | Job `test`: tipos, 196 pruebas con PostgreSQL y contrato PAM con fixtures. Job `e2e`: demo y pila web + worker + PostgreSQL | Ver §5 |

Diferencias entre entornos:
- **Solo en el backend:** copiloto en lenguaje natural (necesita la credencial de Anthropic en el servidor), persistencia, worker, identidad de SS1 y webhooks reales.
- **Solo en la demo:** fecha fija (`?fecha=`), «Restablecer demo», cambios guardados en el navegador y fallas de entrega sembradas en las últimas 48 h. En el backend con `CRM_DEMO_SEED=1` también se siembran.

## 2. Línea base y resultado final

| Verificación | Línea base (`85ee116`) | Final (`074a1c7`) |
|---|---|---|
| Typecheck (CRM y kit Vue) | Limpio | Limpio |
| Lint | **No hay linter configurado** (brecha registrada; `tsc --strict` cubre tipos) | Igual |
| Build estático | OK | OK |
| `npm test` con PostgreSQL | 175 ✔ · 0 ✘ | **196 ✔ · 0 ✘** |
| Robustez de la API, sin errores 5xx | 87 operaciones | **90 operaciones** |
| Navegador | 5 scripts fuera del repositorio | **28 pruebas** en `test/e2e` (local); CI en §5 |
| Contrato PAM | Mapeos con fixtures | Sonda de identidad, validación de filas, 401/403 y fixtures; sin SS1 real (bloqueado) |

## 3. Fase 1: cierre por funcionalidad

| Funcionalidad | Esperado | Observado | Entorno | Evidencia | Estado | Acción pendiente |
|---|---|---|---|---|---|---|
| Selectores de jugador con nombre accesible | Cada selector nombra su recorrido | 9 selectores con nombre; axe sin violaciones | Demo | `test/e2e/demo/a11y.spec.ts` (1.a–1.b) | Verificado | — |
| Sin controles anidados en el Constructor | Paso = botón; salidas hermanas | 0 controles anidados; teclado completo | Demo | `a11y.spec.ts` (2.a–2.i) | Verificado | — |
| «Aceptado» frente a «Entregado» | Un solo significado | «Envíos aceptados» y «Aceptado(s)»; ahora con `delivered` aparte | Demo y backend | `a11y.spec.ts` (3.a–3.c), `docs/DATABASE.md` | Verificado | — |
| Recorrido del jugador en Perfil 360 | Etapa, pendientes y próxima acción permitida | Correcto en 400 jugadores y en las tareas T1–T3 | Ambos | `test/journey_state.test.ts`, `stack/journeys.spec.ts`, `demo/usability_script.spec.ts` | Verificado | Validar con operadores (§4) |
| Ciclo del Constructor | Borrador → … → cierre | Completo, por la interfaz | Ambos | `test/constructor_lifecycle.test.ts`, `stack/journeys.spec.ts` | Verificado | — |
| Aprobar y publicar tras reinicio | La firma sigue válida | **Fallaba:** jsonb reordena claves («content changed after approval») | Backend con base | `test/db_runtime.test.ts` (prueba 7) | Corregido | — |
| Aprobar tras sincronizar | Sin error | **Error 500:** versión pendiente congelada al restaurar | Backend con base | `db_runtime.test.ts` (prueba 7; falla sin la corrección) | Corregido | — |
| Esperas en el backend | Avanzan solas | **Solo avanzaban con `POST /runtime/tick`:** no había planificador | Backend | Worker + intervalo en proceso único; `stack/persistence.spec.ts` | Corregido | — |
| Jugador de otro cliente del PAM | Se descarta | **Se ingería en el tenant** | Backend | `test/pam_validation.test.ts` | Corregido | — |
| Siembra de recorridos al reiniciar | Sin versiones nuevas | Ahora idempotente | Backend con base | `db_runtime.test.ts` (prueba 2) | Corregido | — |
| Revisión en vivo del Constructor | No corre fuera de su pantalla | **Al cambiar de pantalla o rol justo después de editar, avisaba «Tu rol no tiene permiso…» en otra pantalla y repintaba bajo el clic.** Lo detectó CI como prueba inestable en `074a1c7` | Demo y backend | `test/e2e/demo/stale_work.spec.ts` (falla sin la corrección) | Corregido | — |
| Exportaciones CSV | Descarga con encabezados, sin correos | Correcto (tabla y API) | Ambos | `stack/failures.spec.ts` | Verificado | — |
| UX por rol | Cada rol ve lo suyo | Seis roles verificados | Backend | `stack/roles.spec.ts` | Verificado | — |
| Preparación PAM | Contrato con datos reales | Listo con fixtures; falta SS1 | — | Fase 2 §1 | Bloqueado | **SS1:** credencial, filas y `auth/me` |
| Copiloto en lenguaje natural | Responde con herramientas acotadas | Solo herramientas en la demo | Backend | `test/copilot.test.ts` | Solo demo (herramientas) | Credencial de Anthropic en el servidor (operación) |
| Lint | Reglas de estilo | No configurado | — | — | Brecha | Elegir linter (equipo, P3) |

Defectos de Fase 1 que bloqueaban la Fase 2 y se corrigieron primero: planificador de esperas, firma de aprobación y versión congelada (los tres en la ruta de persistencia), y el jugador de otro cliente (en la ruta del contrato).

## 4. Fase 2: cierre por incremento

| # | Incremento | Estado | Evidencia | Entorno · versión | Limitación | Responsable del bloqueo |
|---|---|---|---|---|---|---|
| 1 | Prueba de contrato con SS1 PAM | **Preparado y validado con fixtures; sin correr contra SS1** | `test/pam_validation.test.ts` (7), `test/pam_contract.test.ts` (6), `npm run pam:contract`, `docs/SS1_SOLICITUD_FASE2.md` | Local y CI · `074a1c7` | Faltan: entorno autorizado, credencial de solo lectura, filas reales anonimizadas y `GET /admin/auth/me`. La solicitud está redactada y **pendiente de envío** por el canal del equipo | SS1 (responsable técnico) |
| 2 | Cola de fallas y reproceso manual | **Hecho** | `test/failure_queue.test.ts` (7), `stack/failures.spec.ts`, `demo/fqui.spec.ts` | Demo y pila · `074a1c7` | Reprocesar es individual (sin lotes) | — |
| 3 | Instancias y recibos en PostgreSQL | **Hecho** | `test/db_runtime.test.ts` (7), `stack/persistence.spec.ts`, `docs/DATABASE.md` | PostgreSQL 16 local y CI · `074a1c7` | Bonos, bandeja, fidelidad y casos siguen en memoria; carrera web/worker en el mismo segundo (documentada) | — |
| 4 | Validación con cinco operadores | **Preparado; 0 de 5 sesiones** | `docs/usabilidad/GUION.md`, `resultados_plantilla.csv`, `demo/usability_script.spec.ts` | Demo `?fecha=2026-11-26` | Sin participantes no hay resultados ni cambios derivados | SS1 (coordinar 5 operadores) |
| 5 | Pruebas de navegador en `test/e2e` y CI | **Hecho en local; CI en §5** | `test/e2e/README.md`, `playwright.config.ts`, `.github/workflows/crm-gamification.yml` | Local · `074a1c7` | Auth de desarrollo en la pila de prueba (sin SS1) | — |

### Criterios de cierre

| Criterio | Cumplido | Cómo |
|---|---|---|
| Contrato contra SS1 autorizado con filas reales | No | Bloqueado; el mismo contrato está validado con fixtures y la evidencia faltante, registrada |
| Un operador autorizado encuentra, entiende y reprocesa una falla | Sí | `stack/failures.spec.ts`, por la interfaz |
| Fuera de ámbito no ve ni ejecuta | Sí | Rol sin permiso → 403; auditor solo lee; otro tenant → 404 |
| Dos solicitudes simultáneas no duplican | Sí | En memoria, entre dos réplicas con base y por HTTP (200 y 409) |
| Esperas y recibos sobreviven a reinicios de web y worker | Sí | `db_runtime` 2–3 y `stack/persistence.spec.ts` (procesos reales) |
| Reintentos y conciliación sin duplicados | Sí | Un envío interrumpido pasa a incierto y se concilia sin reenviar (`db_runtime` 4) |
| Cinco sesiones con operadores | No | 0 de 5; kit listo |
| Suite en `test/e2e`, comando local y CI exitoso | Ver §5 | `npm run e2e` |

## 5. Evidencia de CI

| Commit | Ejecución | `test` | `e2e` | Nota |
|---|---|---|---|---|
| `074a1c7` | https://github.com/Merideck24/ss1-control-tower/actions/runs/45849062716 | ✔ 196/196 y contrato PAM | ✔ 26 pasan, **1 inestable** (pasó al reintento) | La inestabilidad era un defecto real de la interfaz (revisión en vivo del Constructor); corregido en el commit siguiente |
| commit final | ver `CONTINUIDAD.md` | | | |

La ejecución local (este equipo, PostgreSQL 16) y la de CI (GitHub Actions, servicio `postgres:16`) son evidencias distintas; las dos están registradas.

## 6. Revisión de uso: iniciar, entender, recuperarse

| Acción | ¿Puede iniciarla quien debe? | ¿Entiende el resultado? | ¿Se recupera de un fallo? |
|---|---|---|---|
| Reprocesar una falla | Analista y admin; los demás ven por qué no pueden | Resultado en lenguaje claro e historial | Si vuelve a fallar queda en la cola con el motivo nuevo; si es incierta, no se reenvía |
| Cerrar un recorrido | Admin, aprobador o JR, con motivo | Mensaje y estado «Cerrado» | Es definitivo (se avisa antes); para reabrir se publica otra versión |
| Publicar tras reinicio | Aprobador | Publicado | Corregido: antes fallaba con un mensaje técnico |
| Contrato PAM | Operación, con la credencial en el entorno | Informe redactado con veredicto | Detenido con motivo si la identidad no cuadra; no lee datos |

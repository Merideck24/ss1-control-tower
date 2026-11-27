# Continuidad · SS1 Control Tower

Estado para retomar el trabajo sin contexto previo. Última actualización: 2026-11-26 (cierre de la Fase 2, `5984751`). CI verde sobre ese commit: https://github.com/Merideck24/ss1-control-tower/actions/runs/45850715652 (196 pruebas y 28 de navegador). La ejecución local, con PostgreSQL 16, dio el mismo resultado; es evidencia aparte.

## Dónde está cada cosa

| Necesito… | Está en |
|---|---|
| Ver la demo | https://merideck24.github.io/ss1-control-tower/ (build estático de `main`, datos sintéticos) |
| Correr el backend | `npm start` → http://localhost:3000 (auth de desarrollo). Con PostgreSQL: `npm run db:migrate`, luego `CRM_ROLE=web npm start` y `npm run worker` |
| Saber qué está cerrado y qué falta | [docs/CIERRE_FASES_1_2.md](docs/CIERRE_FASES_1_2.md): matriz de cierre de las fases 1 y 2 |
| Reprocesar fallas | Pantalla «Cola de fallas»; reglas en `src/channels/failures.ts` |
| Pedir accesos a SS1 | [docs/SS1_SOLICITUD_INTEGRACION.html](docs/SS1_SOLICITUD_INTEGRACION.html) (solicitud formal SS1-CRM-INT-01, pendiente de envío) y el detalle en [docs/SS1_SOLICITUD_FASE2.md](docs/SS1_SOLICITUD_FASE2.md) |
| Gamificación ampliada (retos, logros, tarjetas, tiempo real, regalos, torneos, clasificaciones, concursos, impacto con grupo de control) y lo que falta | [docs/GAMIFICACION.md](docs/GAMIFICACION.md) |
| Sesiones con operadores | [docs/usabilidad/GUION.md](docs/usabilidad/GUION.md) (0 de 5 realizadas) |
| Saber qué se probó y qué falló | [docs/QA_REPORT.md](docs/QA_REPORT.md): matriz por módulo, defectos y evidencia |
| Integrar con el PAM de SS1 | [docs/PAM_INTEGRATION.md](docs/PAM_INTEGRATION.md) y [docs/SS1_DATA_CONTRACT.md](docs/SS1_DATA_CONTRACT.md) |
| Ver la hoja de ruta y las decisiones | [docs/ROADMAP.md](docs/ROADMAP.md) |
| Montarlo en el admin de SS1 | `integrations/ss1-admin/` (Vue/Vuexy, `/dashboard/crm`) |

**Supuesto.** El encargo original menciona un proyecto Next.js y `SS1_Plan_CRM_Gamificacion_IA.md`, que no están en este repositorio. El código real es Node 22 + TypeScript con una interfaz HTML de un solo archivo. El plan de requisitos vigente es [docs/PLAN.md](docs/PLAN.md).

## Cómo verificar antes de publicar

```bash
npm run typecheck
DATABASE_URL=postgres://…/descartable npm test   # 196 pruebas; sin DATABASE_URL se omiten las 11 de PostgreSQL
npm run pam:contract                             # contrato PAM con fixtures sintéticos
npm run openapi && npm run admin:client          # si cambian rutas del catálogo
npm run build:static
E2E_DATABASE_URL=postgres://…/postgres npm run e2e   # 27 pruebas de navegador (demo + web + worker + PostgreSQL)
```

Las pruebas de navegador están en `test/e2e/`: qué se trasladó y qué se recreó está en [test/e2e/README.md](test/e2e/README.md). CI corre las dos suites en cada push y pull request.

## Matriz por módulo: defectos corregidos y su evidencia

| Módulo | Defecto | Estado | Evidencia |
|---|---|---|---|
| Constructor / Registro | D-01: republicar sobre una versión viva daba 500 | Corregido | `test/constructor_lifecycle.test.ts` (falla sin la corrección) |
| Runtime | D-02: instancias de la versión reemplazada quedaban colgadas | Corregido | Mismo test, paso 6 |
| Constructor | D-03: faltaba el cierre del ciclo | Corregido | Test paso 7; `closeui.cjs` U.1, U.3 y U.4 |
| Constructor | D-04: faltaba el seguimiento por recorrido | Corregido | Test pasos 4–7; `closeui.cjs` U.2 |
| Perfil 360 | D-05: no mostraba etapa, pendientes ni próxima acción | Corregido | `test/journey_state.test.ts`; 400 jugadores sin errores |
| Perfil 360 | D-06: panel desplazable sin foco de teclado | Corregido | axe: 0 violaciones |
| Integración PAM | D-07: conectores atados al cliente HTTP | Corregido | `test/pam_contract.test.ts` (2 adaptadores, misma suite) |
| Constructor | Selectores de simulación sin nombre accesible (`cf65b32`) | Corregido y reverificado | `a11y.cjs` 1.a–1.b |
| Constructor | Controles anidados en el lienzo (`cf65b32`) | Corregido y reverificado | `a11y.cjs` 2.a–2.i |
| Control Tower / Analítica | «Aceptado» frente a «Entregado» (`cf65b32`) | Corregido y reverificado | `a11y.cjs` 3.a–3.c |

Los defectos de incrementos anteriores (16 hallazgos de UX, revisión externa y barrido de fallas) están en el historial de git y en `test/ux_findings.test.ts`, `test/api_robustness.test.ts` y `test/e2e_player_lifecycle.test.ts`.

## Fase 2: defectos corregidos y su evidencia

| Módulo | Defecto | Estado | Evidencia |
|---|---|---|---|
| Constructor / Registro | Un recorrido aprobado antes de un reinicio no se podía publicar: jsonb reordena claves y la firma no coincidía | Corregido (firma sobre JSON canónico; se acepta la anterior) | `test/db_runtime.test.ts` prueba 7 (falla sin la corrección) |
| Registro | Aprobar una versión llegada por sincronización daba 500 (versión congelada) | Corregido | Misma prueba |
| Runtime | El backend no tenía planificador: las esperas solo avanzaban con `POST /runtime/tick` | Corregido (worker y, sin base, intervalo en el proceso) | `stack/persistence.spec.ts` |
| Integración PAM | Un jugador de otro cliente del admin se ingería en el tenant | Corregido | `test/pam_validation.test.ts` |
| Auditoría | Web y worker numeraban la misma cadena: se habrían perdido registros | Corregido (una cadena por escritor) | `db_runtime.test.ts` prueba 3 |
| Demo / arranque | Reiniciar con base creaba versiones nuevas de los recorridos sembrados | Corregido | `db_runtime.test.ts` prueba 2 |
| Cola de fallas | El detalle de una falla resuelta perdía el motivo original | Corregido | `test/failure_queue.test.ts` |

## Bloqueos que dependen de SS1

1. **Prueba de contrato real.** Necesita, en una sola entrega: URL del entorno autorizado, credencial de solo lectura (por el gestor de secretos), filas reales anonimizadas y acceso a `GET /admin/auth/me`. La solicitud está en `docs/SS1_SOLICITUD_FASE2.md`, **pendiente de envío** por el canal del equipo. Con eso: `SS1_API_BASE=… SS1_API_TOKEN=… npm run pam:contract -- --live --out <ruta fuera del repo>`.
2. **Cinco operadores** para las sesiones de usabilidad (0 de 5).
3. Campos de jugador (email, idioma, zona horaria, afiliado y consentimiento) y la fuente de casos de soporte.

## Siguiente incremento (en orden)

1. Correr el contrato contra SS1 apenas lleguen los accesos y resolver o asignar cada discrepancia del informe.
2. Hacer las cinco sesiones, corregir los problemas de interfaz prioritarios y repetir esas tareas.
3. Persistir bonos con la reserva de presupuesto en la misma transacción y la bandeja in-app (`docs/DATABASE.md`). Los libros de XP y monedas ya son durables (migración 004).
4. Sincronizar la gamificación (retos, regalos, torneos, concursos) entre réplicas de la web; hoy se carga al arrancar y cada réplica escribe lo suyo.
5. Conectar el mecanismo de sorteo autorizado de SS1 como `DrawProvider` (`src/gamification/contests.ts`).
6. Escritura condicional por versión en `journey_instances`, para cerrar la carrera web/worker documentada.
7. Configurar un linter.

## Reglas que no cambian

- El CRM nunca escribe en el PAM. Si falta un dato de juego responsable o está desactualizado, se bloquea el marketing.
- Ningún secreto, credencial ni token en el repositorio, en logs ni en el contexto de la IA. Van como secretos del entorno.
- Autor ≠ aprobador. Una versión publicada es inmutable; un cambio es una versión nueva que pasa otra vez por aprobación.
- La felicitación de nivel es marketing y respeta los topes del mercado (2 por día, 5 por semana). Si ya se cumplieron, se suprime con motivo y no se reenvía.

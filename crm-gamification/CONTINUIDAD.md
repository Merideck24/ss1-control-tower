# Continuidad · SS1 Control Tower

Estado para retomar el trabajo sin contexto previo. Última actualización: 2026-11-26.

## Dónde está cada cosa

| Necesito… | Está en |
|---|---|
| Ver la demo | https://merideck24.github.io/ss1-control-tower/ (build estático de `main`, datos sintéticos) |
| Correr el backend | `npm start` → http://localhost:3000 (auth de desarrollo) |
| Saber qué se probó y qué falló | [docs/QA_REPORT.md](docs/QA_REPORT.md): matriz por módulo, defectos y evidencia |
| Integrar con el PAM de SS1 | [docs/PAM_INTEGRATION.md](docs/PAM_INTEGRATION.md) y [docs/SS1_DATA_CONTRACT.md](docs/SS1_DATA_CONTRACT.md) |
| Ver la hoja de ruta y las decisiones | [docs/ROADMAP.md](docs/ROADMAP.md) |
| Montarlo en el admin de SS1 | `integrations/ss1-admin/` (Vue/Vuexy, `/dashboard/crm`) |

**Supuesto.** El encargo original menciona un proyecto Next.js y `SS1_Plan_CRM_Gamificacion_IA.md`, que no están en este repositorio. El código real es Node 22 + TypeScript con una interfaz HTML de un solo archivo. El plan de requisitos vigente es [docs/PLAN.md](docs/PLAN.md).

## Cómo verificar antes de publicar

```bash
npm test            # 171 pruebas (+4 con PostgreSQL: npm run test:db)
npm run typecheck
npm run openapi && npm run admin:client   # si cambian rutas del catálogo
npm run build:static
```

Las pruebas de navegador (Playwright y axe-core) viven fuera del repositorio, en el directorio de trabajo de la sesión: `findings.cjs`, `a11y.cjs`, `formtest.cjs`, `jstate.cjs` y `closeui.cjs`. Moverlas a `test/e2e/` es una tarea pendiente.

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

## Bloqueos que dependen de SS1

1. Credencial de servicio de solo lectura (sandbox o piloto). Sin ella no se puede correr la prueba de contrato con datos reales.
2. `GET /admin/auth/me`, para resolver tenant y rol desde la sesión del operador.
3. Campos de jugador: email, idioma, zona horaria, afiliado y consentimiento de marketing.
4. Fuente de casos de soporte.

## Siguiente incremento (en orden)

1. Prueba de contrato `pam_contract` con filas reales anonimizadas de SS1: puerta Sandbox → Piloto.
2. Pantalla de cola de fallas con reproceso manual.
3. Instancias del runtime y recibos en PostgreSQL.
4. Pruebas con 5 operadores de SS1 para validar la autoevaluación de UX.
5. Mover las pruebas de navegador a `test/e2e/` y correrlas en CI.

## Reglas que no cambian

- El CRM nunca escribe en el PAM. Si falta un dato de juego responsable o está desactualizado, se bloquea el marketing.
- Ningún secreto, credencial ni token en el repositorio, en logs ni en el contexto de la IA. Van como secretos del entorno.
- Autor ≠ aprobador. Una versión publicada es inmutable; un cambio es una versión nueva que pasa otra vez por aprobación.
- La felicitación de nivel es marketing y respeta los topes del mercado (2 por día, 5 por semana). Si ya se cumplieron, se suprime con motivo y no se reenvía.

# Pruebas de navegador (Playwright)

```bash
npm run build:static                                   # la demo publicada (dist/index.html)
E2E_DATABASE_URL=postgres://usuario@host:5432/postgres npm run e2e
```

`E2E_DATABASE_URL` es un rol administrador sobre un servidor PostgreSQL **de prueba**. Cada pila crea y migra su propia base (`crm_e2e_main`, `crm_e2e_restart`) y la borra en la corrida siguiente. Sin esa variable solo corre el proyecto `demo` (`npm run e2e:demo`). Si una prueba falla, en `test-results/` quedan su traza (`npx playwright show-trace …/trace.zip`), la captura y los registros de la web y del worker (`test-results/stack-logs/`).

## Proyectos

| Proyecto | Contra qué corre | Datos |
|---|---|---|
| `demo` | La demo publicada: el build estático que sirve GitHub Pages, sin servidor | Sintéticos, reproducibles por fecha |
| `stack` | Web (`CRM_ROLE=web`) y worker (`npm run worker`) como procesos separados, sobre PostgreSQL | 90 días sintéticos (`CRM_DEMO_SEED=1`) más los que crea cada prueba con ids únicos |

La pila usa `CRM_DEV_AUTH=1`: el rol y el tenant van por cabecera. Es la única diferencia con producción, porque la identidad real de SS1 (`GET /admin/auth/me`) no está disponible en CI. Ninguna prueba usa credenciales ni datos reales de SS1.

## Cobertura

| Requisito | Prueba |
|---|---|
| Navegación por rol | `stack/roles.spec.ts` (seis roles: pestañas que debe y no debe ver; cada pestaña abre sin error) |
| Perfil 360 | `stack/journeys.spec.ts`, `demo/p360.spec.ts` |
| Cambio de tenant | `stack/roles.spec.ts` |
| Constructor, aprobación y publicación | `stack/journeys.spec.ts` (por la interfaz, con autor ≠ aprobador) |
| Simulación sin efectos externos | `stack/journeys.spec.ts`, `demo/usability_script.spec.ts` |
| Cola de fallas y reproceso | `stack/failures.spec.ts`, `demo/fqui.spec.ts` |
| Concurrencia del reproceso | `stack/failures.spec.ts` (dos solicitudes simultáneas → 200 y 409) |
| Persistencia tras reinicio | `stack/persistence.spec.ts` (detiene web y worker mientras vence una espera) |
| Exportación CSV | `stack/failures.spec.ts` (descarga de la tabla y CSV de la API) |
| Accesibilidad y móvil | `stack/roles.spec.ts` (axe en 7 pantallas; 390 px), `demo/a11y.spec.ts` |

## Origen

**Trasladadas** desde el directorio de trabajo de las fases 1 y 2, con sus comprobaciones intactas. Solo cambió el arranque del navegador, las rutas y el cierre, que ahora es una aserción:

| Script original | Prueba | Comprobaciones |
|---|---|---|
| `findings.cjs` | `demo/findings.spec.ts` | 22 |
| `a11y.cjs` (los tres hallazgos del QA previo) | `demo/a11y.spec.ts` | 16 |
| `formtest.cjs` | `demo/formtest.spec.ts` | 27 |
| `closeui.cjs` | `demo/closeui.spec.ts` | 5 |
| `fqui.cjs` | `demo/fqui.spec.ts` | 12 |
| `p360.cjs` | `demo/p360.spec.ts` | 11 + variantes por ancho |

**Recreadas** para la pila real: todas las de `stack/` y `demo/usability_script.spec.ts`. `jstate.cjs` y `mobile-all.cjs` no tenían comprobaciones con resultado (solo imprimían), así que se recrearon como aserciones en `stack/journeys.spec.ts` y `stack/roles.spec.ts`.

**No trasladados.** Unos 50 scripts exploratorios de una sola vez: sondeos de desborde (`ovf*.cjs`), capturas (`shots.cjs`, `design.cjs`) y revisiones puntuales de pantallas ya cubiertas. Repetían comprobaciones que hoy están en las pruebas de arriba o en `test/ux_findings.test.ts`.

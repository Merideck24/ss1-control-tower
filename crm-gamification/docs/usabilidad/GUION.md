# Validación con operadores de SS1 · guion de sesión

**Estado:** preparado · **sesiones realizadas: 0 de 5** · faltan los participantes (los coordina el responsable de SS1, ver §7).

Objetivo: comprobar con operadores reales si la autoevaluación de UX de la Fase 1 (`docs/QA_REPORT.md`) se sostiene, en las tareas que más pesan en la operación diaria.

## 1. Participantes

Cinco operadores de SS1 que hoy trabajen en CRM, soporte o cumplimiento. Idealmente:

| Perfil | Cantidad | Rol en la demo |
|---|---|---|
| Analista de CRM o marketing | 2 | `crm_analyst` |
| Soporte al jugador | 1 | `support` |
| Aprobador o líder de CRM | 1 | `approver` |
| Cumplimiento o juego responsable | 1 | `rg_officer` |

No hace falta experiencia previa con el CRM. La participación es voluntaria y se puede dejar en cualquier momento. No se graba la cara ni la voz sin consentimiento escrito; basta la pantalla y las notas.

## 2. Preparación (10 min antes)

- Navegador de escritorio con la demo y la fecha fija, para que todos vean los mismos datos: `https://merideck24.github.io/ss1-control-tower/?fecha=2026-11-26`.
- Botón **Restablecer demo** (menú lateral) entre sesiones.
- El rol se elige en la cabecera. Cada tarea indica cuál usar.
- Datos 100 % sintéticos: ningún jugador es real.
- El moderador no explica la interfaz. Solo lee la tarea, y si el participante se traba más de 2 minutos ofrece una pista (se registra como ayuda).

## 3. Tareas

Se lee la tarea tal cual. Se mide desde que termina la lectura hasta que el participante dice «listo» o abandona.

| # | Rol | Tarea (texto para el participante) | Éxito si… | Tiempo objetivo |
|---|---|---|---|---|
| T1 | Analista | «Busca al jugador **acq_affiliate_0010** y dime en qué etapa está y qué se le puede ofrecer ahora.» | Dice «primer depósito» y «invitarlo al primer depósito» por un canal permitido | 2 min |
| T2 | Soporte | «El jugador **acq_org_0013** dice que no le llegan promociones. ¿Por qué?» | Explica que está autoexcluido y que solo recibe mensajes de servicio | 2 min |
| T3 | Analista | «El jugador **acq_meta_0155** tampoco recibe promociones. ¿Es por lo mismo?» | Distingue: no es juego responsable, retiró el consentimiento en in-app y email | 2 min |
| T4 | Analista | «Antes de publicar el recorrido *Registro → verificación pendiente*, simula qué le pasaría al jugador **acq_google_0002**.» | Ejecuta la simulación y dice que no se envió nada real | 3 min |
| T5 | Analista | «Hay mensajes que no salieron por una caída del proveedor. Encuentra uno y dime qué pasó.» | Llega a la Cola de fallas, filtra o elige una falla transitoria (p. ej. **acq_google_1179**) y explica el motivo | 3 min |
| T6 | Analista | «Decide si conviene reprocesar esa falla y, si conviene, hazlo.» | Reprocesa con motivo y confirmación, y lee el resultado | 2 min |
| T7 | Analista | «Este otro mensaje quedó *incierto* (**acq_google_0886**). ¿Lo reenviarías?» | Entiende que primero se concilia con el proveedor y que no se reenvía a ciegas | 2 min |
| T8 | Analista | «Y este (**acq_google_0709**, SMS). ¿Lo reprocesas?» | Decide **no** reprocesar: falta el teléfono en el PAM y hay que corregir el canal | 2 min |
| T9 | Cumplimiento | «Verifica que el oficial de juego responsable no puede reprocesar mensajes.» | Constata que no ve la Cola de fallas | 1 min |

Después de cada tarea: «Del 1 al 5, ¿qué tan fácil fue?» (1 = muy difícil, 5 = muy fácil).

## 4. Qué se registra por tarea

En `resultados_plantilla.csv` (una fila por participante y tarea; sin nombres):

| Campo | Valores |
|---|---|
| `sesion` | S1…S5 |
| `perfil` | analista, soporte, aprobador, cumplimiento |
| `tarea` | T1…T9 |
| `exito` | 2 = sin ayuda · 1 = con una pista · 0 = no lo logró |
| `tiempo_s` | segundos |
| `pasos` | clics o pantallas hasta terminar |
| `errores` | pasos equivocados (p. ej. abrir otra pantalla) |
| `ayuda` | sí / no, y qué pista |
| `facilidad` | 1–5 |
| `tipo_problema` | `interfaz` (la pantalla confunde), `formacion` (falta un concepto del dominio) o `politica` (la regla operativa no está clara o no es la correcta) |
| `comentario` | frase textual breve, sin datos personales |

## 5. Rúbrica de decisión

- **Problema prioritario:** dos o más participantes fallan o piden ayuda en la misma tarea por la misma causa.
- **Interfaz:** se corrige en el producto y se vuelve a probar esa tarea con al menos dos participantes.
- **Formación:** se agrega a la guía del operador. Si se repite en tres o más, también es de interfaz.
- **Política:** se escala al responsable de CRM o Cumplimiento de SS1. No se corrige en la interfaz sin su decisión.
- **Una tarea se cumple** si 4 de 5 la logran (éxito ≥ 1) dentro de 1,5 veces el tiempo objetivo.

## 6. Contra la autoevaluación de la Fase 1

Hipótesis que la autoevaluación dio por buenas y que estas sesiones confirman o refutan:

| Hipótesis (Fase 1) | Tareas |
|---|---|
| Perfil 360 explica en lenguaje claro por qué un jugador no recibe marketing | T2, T3 |
| La próxima acción permitida se entiende sin conocer las reglas internas | T1 |
| La simulación deja claro que no hubo efectos externos | T4 |
| La cola permite decidir si reprocesar sin leer el código de error | T5–T8 |
| Los permisos por rol son visibles | T9 |

## 7. Pedido a SS1

Mismo canal que la solicitud técnica (`docs/SS1_SOLICITUD_FASE2.md`):

1. Cinco operadores con los perfiles de §1, 45 minutos cada uno, en dos semanas.
2. Un moderador de SS1 que conozca el vocabulario operativo (opcional; si no, modera el equipo del CRM).
3. Autorización para tomar notas anonimizadas y, si el participante acepta, grabar pantalla.

## 8. Resultados

| Sesión | Fecha | Perfil | Estado |
|---|---|---|---|
| S1–S5 | — | — | Sin realizar: faltan participantes |

El guion es ejecutable: `test/e2e/usability_script.spec.ts` recorre las nueve tareas con los datos indicados y comprueba que cada una tiene solución en la demo. Esa prueba **no** reemplaza las sesiones, porque no mide comprensión.

# Trazabilidad requisito → código → prueba

| ID | Criterio de aceptación (resumen) | Implementación | Prueba |
|---|---|---|---|
| CRM-01 | Línea de tiempo reconstruible; origen y fecha de cada campo crítico | `src/profile/projection.ts` (`Tracked<T>`, `profileView`), `src/ingestion/ingestor.ts` | `test/crm01_profile_ingestion.test.ts` |
| CRM-02 | Mismo snapshot ⇒ mismo resultado; revalidación al ejecutar | `src/segments/segmentEngine.ts` (`runSegment`), revalidación en `JourneyRuntime` + `PolicyEngine` | `test/crm02_segments.test.ts` |
| CRM-03 | Crear y simular sin código; versión publicada fija | `src/journeys/{model,registry,runtime}.ts` (`deepFreeze`, versión fijada por instancia, `simulateJourney`) | `test/crm03_journeys.test.ts` |
| CRM-04 | Canal, consentimiento, frecuencia y zona horaria por propósito; fallo trazado | `src/policy/policyEngine.ts`, `src/channels/channels.ts` (recibos, reintentos acotados, idempotencia) | `test/crm04_08_policy.test.ts` |
| CRM-05 | Tokens/enlaces fuera de eventos y logs; CRM recibe solo estados | `validateEnvelope` (claves prohibidas), `redact` en auditoría | `test/crm05_secrets.test.ts` |
| CRM-06 | Duplicado ⇒ acción lógica única; 50 % entre umbrales, una vez por nivel/temporada | Dedup en ingesta + id de instancia; `LoyaltyService.progress` y `#notified` | `test/crm06_07_rewards_loyalty.test.ts`, `test/replay.test.ts` |
| CRM-07 | Repetición no duplica bono ni cargo; conciliación | `src/rewards/rewards.ts` (reserva, clave única, estado `uncertain` → lookup, `reconcile`) | `test/crm06_07_rewards_loyalty.test.ts` |
| CRM-08 | Autoexclusión mientras espera ⇒ bloqueo al revalidar, con motivo y versión; pausa; auditoría | `PolicyEngine.decide` (fail-closed), cancelación por `rg.status_changed`, `setPaused`, `setGlobalPause`, `AuditLog` encadenado | `test/crm04_08_policy.test.ts` |
| CRM-09 | Asignación persistente; denominador, ventana, costo; observado vs. estimado | `src/experiments/experiments.ts` | `test/crm09_experiments.test.ts` |
| CRM-10 (parcial) | Reverso con asiento compensatorio | `LoyaltyService.reverse` | `test/crm06_07_rewards_loyalty.test.ts` |
| IA | Sin escrituras fuera de borradores; bloqueo entre tenants; permisos por rol; k-anonimato | `src/copilot/tools.ts`, `src/copilot/agent.ts` | `test/copilot.test.ts` |
| Aislamiento | Dos tenants en pruebas | Claves compuestas `tenant::…` en todos los almacenes | `test/replay.test.ts` |

## Primeros recorridos del plan

| # | Recorrido | Estado en el MVP |
|---|---|---|
| 1 | Registro → verificación pendiente → recordatorio → salida al verificar | `j1_verification` (servicio, `exit_on: player.verified`) |
| 2 | Recuperación → identidad emite y valida credencial → confirmación | Vive en PAM/identidad; CRM solo recibe estados. Plantilla `security_confirmation` lista |
| 3 | Recompensa confirmada → elegibilidad → mensaje con vigencia | `j3_reward_notice` (marketing, 10 % control) |
| 4 | Nivel → cruce del 50 % → aviso → widget | `j4_loyalty_halfway` + vista «Fidelidad (móvil)» |
| 5 | Cambio JR → supresión y cancelación de pendientes | Comportamiento del runtime (`rg.status_changed`) + revalidación |

## Pendiente (fuera del MVP o por confirmar en S0)

- Persistencia real (PostgreSQL, outbox, broker, ejecutor de workflows con temporizadores durables): hoy en memoria.
- Integración con PAM, bonos e identidad SS1 reales; adaptadores reales de email y web push.
- Identidad/RBAC SS1 en lugar de cabeceras de desarrollo.
- Fase 2: misiones, canjes con stock concurrente, WhatsApp/Telegram, opt-out persistente de gamificación.
- Fase 3: torneos, tienda ampliada, modelos de próxima acción.
- Evaluación del copiloto (modo sombra, conjunto etiquetado, ≥ 90 % de coincidencia cuantitativa).

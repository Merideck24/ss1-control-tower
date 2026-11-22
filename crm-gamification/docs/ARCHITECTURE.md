# Arquitectura del MVP

```
 PAM · KYC · pagos · sportsbook · agregador · bonos
            │ eventos normalizados (contracts/events.asyncapi.yaml)
            ▼
   ┌─────────────────┐  dedup (tenant,event_id) · validación · cola de errores · métricas por fuente
   │    Ingestor     │
   └───────┬─────────┘
           ▼
   Proyección del jugador (Perfil 360, campos con fuente/versión/vigencia)
           │
     ┌─────┴───────────────┬───────────────────────┐
     ▼                     ▼                       ▼
 Segmentos            Fidelidad (libro)      Runtime de recorridos ◄── Registro (borrador → aprobación → publicación firmada)
                           │ loyalty.threshold_crossed   │
                           └──────────► Ingestor         │ antes de cada efecto
                                                         ▼
                                               Servicio de políticas (fail-closed)
                                                 │                 │
                                                 ▼                 ▼
                                        ChannelHub (recibos,   RewardService (presupuesto,
                                        idempotencia)          idempotencia, conciliación) ──► Servicio de bonos SS1
                                                                                                 │ reward.granted
                                                                                                 └──► Ingestor
   Auditoría encadenada (hash) ◄── todos los cambios y decisiones
   Copiloto IA ──► herramientas tipadas (lectura agregada + borradores) ──► mismos servicios
```

## Principios aplicados

- **Responsabilidad de datos.** PAM/identidad conserva credenciales y KYC; wallet/bonos conserva saldos y otorgamientos; CRM guarda proyecciones, recorridos, plantillas y auditoría; fidelidad mantiene su propio libro.
- **Fail-closed.** Si el estado de juego responsable falta o el feed está desactualizado, se suprimen marketing e incentivos y se genera una alerta operativa. Los mensajes de servicio siguen su propia política.
- **Idempotencia extremo a extremo.** Dedup en ingesta; id de instancia `tenant:journey:version:player:event`; clave de envío `instance:node`; clave de otorgamiento única con reserva de presupuesto. Un resultado incierto se concilia (`lookup`) antes de reenviar.
- **Versionado inmutable.** Las versiones publicadas se congelan y cada instancia fija su versión. La aprobación firma el contenido; cualquier cambio exige nueva aprobación.
- **Pausa.** La pausa por recorrido o general impide nuevos efectos desde SS1; las instancias quedan esperando hasta reanudar.
- **Aislamiento de tenant.** Claves compuestas por tenant en todos los almacenes; el backend toma el tenant de la sesión, nunca del cuerpo ni del modelo.

## Del MVP en memoria a producción

| Componente MVP | Producción propuesta |
|---|---|
| `Map` en memoria | PostgreSQL (configuración, estados, libro, presupuestos con `UPDATE … WHERE remaining >= value`) |
| Suscripción síncrona | Broker existente o administrado, outbox en productores, partición tenant/jugador |
| `runDue()` | Ejecutor de workflows con temporizadores persistentes |
| `MemoryAdapter` | Proveedores de email y web push con webhooks de recibos |
| `MockBonusService` | Servicio de bonos SS1 (idempotencia por clave) |
| Cabeceras de sesión | Identidad SS1 (OIDC) + RBAC |
| Auditoría encadenada en memoria | Almacén append-only + exportación al almacén analítico |

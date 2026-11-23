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

## Adquisición y valor (Control Tower)

`src/analytics/performance.ts` es un almacén analítico mínimo que consume los mismos eventos que el CRM más `marketing.spend_reported` (inversión diaria por campaña desde plataformas de medios y afiliados). El registro del jugador puede traer `acquisition.campaign_id` y `bet.settled` incluye `win` para calcular GGR.

| Métrica | Definición |
|---|---|
| CTR | clics / impresiones |
| FTD % | FTD / registros de la cohorte |
| CPA | inversión / registros |
| Costo por FTD | inversión / FTD |
| Depósitos | depósitos liquidados de la cohorte, netos de reversos |
| GGR | apuestas − premios |
| NGR | GGR − costo de bonos confirmados − impuesto sobre GGR (tasa de la definición financiera) |
| Retención D7 / D30 | % de FTD con actividad (apuesta o depósito) 7 / 30 días o más después del FTD; solo FTD con esa antigüedad |
| ROI | (NGR − inversión) / inversión; los bonos ya están en el NGR y no se descuentan dos veces |

**Modelo de cohorte.** La cohorte de una campaña son los jugadores registrados en el período con esa atribución; su valor se mide desde el registro hasta la fecha de corte. Una cohorte sin FTD con la antigüedad suficiente se muestra como «inmadura» en lugar de 0 %.

**Pendiente de validar con Finanzas:** la tasa de impuesto sobre GGR (0,15 es un valor de ejemplo), si el costo de bonos se reconoce al otorgar o al convertir, retiros y ajustes de pagos, y la conciliación de monedas. La definición está versionada (`finance_definition.version`) y se muestra en el dashboard.

### Payback por cohorte

Cohorte = campaña × semana de registro (lunes a domingo, UTC). `recuperado(t)` = NGR acumulado de la cohorte hasta el día t desde el registro / inversión de la campaña esa semana. El día de payback es el primer t con recuperado ≥ 100 %. Las curvas por campaña promedian solo cohortes con al menos t días (contados desde el fin de la semana) y se cortan cuando quedan menos de dos, para no mostrar cambios de composición como tendencia. La proyección usa el ritmo de NGR de los últimos 14 días y es indicativa.

### Alertas de KPI

`src/analytics/kpiAlerts.ts` evalúa reglas deterministas en cada consulta:

| Regla | Disparo | Severidad |
|---|---|---|
| `ctr_drop` | CTR 7 d cae ≥ 25 % vs. 28 d previos **y** z ≤ −1,96 | media / alta |
| `ftd_rate_drop` | FTD % cae ≥ 25 % (ventanas con corte −2 d) **y** z ≤ −1,96 | alta |
| `cpa_rise` | CPA 7 d sube ≥ 30 % vs. 28 d previos | media / alta |
| `cost_per_ftd_above_target` | costo por FTD 30 d sobre el objetivo del tenant | media / alta |
| `payback_overdue` / `payback_at_risk` | cohortes ≥ 60 d sin payback, o en riesgo según proyección (agrupado por campaña) | alta / media |
| `spend_missing` | campaña activa sin reporte de inversión ≥ 2 días | alta |
| `rg_share_high` | > 8 % de la cohorte 30 d con restricción de juego responsable (mín. 5 casos) | crítica |
| `bonus_budget` | presupuesto de bonos ≥ 80 % / ≥ 95 % | media / alta |

Todas exigen muestra mínima. Los umbrales son valores de ejemplo por tenant, editables por `tenant_admin`; cada cambio y cada reconocimiento queda en la auditoría.

La demo reproduce la historia avanzando el reloj con los eventos (y procesando esperas cada hora simulada) para que bonos y mensajes queden con su fecha real.

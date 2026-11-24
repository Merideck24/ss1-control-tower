# API REST (MVP)

Base: `/api`. Las rutas viven en `src/api/router.ts` (puro); `server.ts` lo expone por HTTP y `browser.ts` lo ejecuta en la demo estática. Cada acción exige un permiso (`PERMISSIONS`) y devuelve `403` con los roles válidos si falta. Sesión de desarrollo por cabeceras — **reemplazar por identidad SS1 (OIDC) antes de producción**:

| Cabecera | Ejemplo | Uso |
|---|---|---|
| `x-tenant-id` | `tenant-rumbawin` | Frontera de tenant; todo se filtra por este valor |
| `x-actor` | `ana@ss1` | Autor en auditoría |
| `x-roles` | `crm_analyst,approver` | `crm_analyst`, `approver`, `support`, `rg_officer`, `tenant_admin`, `auditor` |

| Método y ruta | Descripción | Requisito |
|---|---|---|
| `GET /health` | Liveness | — |
| `GET /session` | Rol, permisos efectivos y herramientas del copiloto disponibles | RBAC |
| `GET /control-tower` | Recorridos, entregas, supresiones, fallos, presupuestos, alertas, métricas por fuente | Control Tower |
| `POST /events` | Ingesta de un evento normalizado (`202 applied/duplicate`, `422 rejected`) | CRM-01 |
| `GET /players?q=` | Búsqueda por player_id seudonimizado | CRM-01 |
| `GET /players/:id` | Perfil 360 con procedencia, explicación de elegibilidad, fidelidad, recibos, instancias | CRM-01, CRM-08 |
| `GET /segments/fields` · `POST /segments/preview` | Catálogo de campos y estimación de segmento | CRM-02 |
| `GET /journeys` · `POST /journeys` | Listado (con vista accesible en lista) y guardado de borrador | CRM-03 |
| `POST /journeys/:id/submit\|approve\|publish\|pause\|resume` | Ciclo de vida con aprobación separada | CRM-03, CRM-08 |
| `POST /journeys/:id/simulate` | Simulación sin efectos contra un jugador `{player_id, payload}` | CRM-03 |
| `POST /runtime/tick` | Procesa temporizadores vencidos (demo: `{advance_hours}`) | CRM-03 |
| `POST /runtime/pause` | Pausa general por tenant (`tenant_admin` / `rg_officer`) | CRM-08 |
| `GET /rewards` · `POST /rewards/reconcile` | Catálogo, presupuesto, otorgamientos y conciliación | CRM-07 |
| `GET /performance?days=60` | Adquisición y valor por campaña: inversión, CTR, FTD %, CPA, costo por FTD, depósitos, GGR, NGR, retención D7/D30, ROI, alcance CRM y nivel Loyalty (`performance.read`) | Control Tower |
| `GET /performance/payback?weeks=12` | Payback por cohorte semanal (campaña × semana de registro) y curvas de recuperación por campaña (`performance.read`) | Control Tower |
| `GET /kpi-alerts` | Alertas de KPI activas, con umbrales y reconocimientos (`alerts.read`) | Control Tower |
| `POST /kpi-alerts/:id/ack` | Marca una alerta como revisada, con nota opcional; queda en auditoría (`alerts.ack`) | Control Tower |
| `PUT /kpi-alerts/config` | Ajusta umbrales del tenant; valida claves y valores (`alerts.configure`, solo `tenant_admin`) | Control Tower |
| `GET /analytics/campaigns` | Tratamiento vs. control, IC 95 %, costo | CRM-09 |
| `GET /audit` | Registro encadenado (`auditor`, `tenant_admin`, `approver`) | CRM-08 |
| `GET /copilot/tools` · `POST /copilot/tools/:name` | Herramientas del copiloto según rol | IA |
| `POST /copilot/ask` | Pregunta en lenguaje natural (Claude, requiere credenciales) | IA |

## Riesgo: abuso de bonos (G9)

| Método y ruta | Permiso | Descripción |
|---|---|---|
| `GET /risk/bonus-abuse` | `abuse.read` | Niveles, señales, bonos retenidos/escalados y jugadores marcados con su explicación |
| `POST /risk/bonus-abuse/:player/review` | `abuse.review` | `{ status: 'cleared' \| 'confirmed', note }`; auditado, vence a 30 días |

`GET /players/:id` incluye `bonus_abuse` solo para roles con `abuse.read`. Eventos: `player.registered.device_hash` y `deposit.settled.instrument_hash` (opcionales, siempre hash).

## Constructor visual (D2)

| Método y ruta | Permiso | Descripción |
|---|---|---|
| `GET /journeys/builder` | `journeys.draft` | Catálogo para el lienzo: eventos de jugador, canales, plantillas, recompensas, campos de segmento y tipos de paso |
| `POST /journeys/review` | `journeys.draft` | Revisión en vivo del borrador: `issues` (mensaje, paso, severidad), `valid`, `layout` automático y vista en lista |

`layout` (posiciones por paso) es opcional en `POST /journeys` y forma parte de la versión firmada.

## Solapamiento y frecuencia (D3, D4)

| Método y ruta | Permiso | Descripción |
|---|---|---|
| `GET /journeys/overlap` | — | Grupos con prioridad, entradas, desplazadas y bloqueadas; riesgos de colisión; topes de frecuencia vigentes |

Recorridos: `overlap: { group, priority (1–100), cooldown_hours? }` (solo marketing). Estados de instancia nuevos: `preempted`, `blocked_overlap`. Política: `max_marketing_per_day_by_channel`, `max_marketing_per_week`; motivos `frequency_cap_channel:<canal>` y `frequency_cap_week`.

## Experimentos A/B/n (D5)

| Método y ruta | Permiso | Descripción |
|---|---|---|
| `GET /experiments/splits` | `analytics.read` | Por cada paso A/B/n publicado: fase (fijo, calentamiento, optimizando), asignados, cerrados, conversiones, tasa con IC 95 %, probabilidad de ser la mejor, reparto actual y decisión |

Paso `split`: `{ mode: 'fixed' \| 'bandit', metric: { event, window_hours }, variants: [{ id, label, weight, next }], min_explore_pct?, warmup_per_variant? }`.

## Juego responsable (I2, D6)

| Método y ruta | Permiso | Descripción |
|---|---|---|
| `GET /risk/rg-monitor` | `rg.monitor` | Resumen de casos, señales, intervenciones y cola priorizada |
| `POST /risk/rg-cases/:id/take` | `rg.act` | Asigna el caso a quien lo toma |
| `POST /risk/rg-cases/:id/close` | `rg.act` | `{ outcome: contacted \| limits_suggested \| escalated_to_rg \| no_action, note }`; auditado |

Evento interno `rg.risk_signal` (`source: crm.risk`): `{ level, score, signals }`. `GET /players/:id` incluye `rg_risk` solo para roles con `rg.monitor`.

## Canales y bandeja (F2, F4)

| Método y ruta | Permiso | Descripción |
|---|---|---|
| `GET /channels/status` | `analytics.read` | Entregados, fallidos, suprimidos y diferidos por canal, con motivos; estado de la bandeja y del transporte |
| `GET /players/:id/inbox` | `players.read` | Bandeja vigente (`?archived=1` incluye archivados) y no leídos |
| `POST /players/:id/inbox/:msg/read` · `/archive` | `player.preferences` | Marca leído o archiva |
| `POST /players/:id/inbox/read-all` | `player.preferences` | Marca todo como leído |

Canales: `inapp`, `email`, `webpush`, `sms`, `whatsapp`, `telegram`. Plantillas: `channels.sms` (texto corto por idioma) y `channels.whatsapp` (`name`, `lang`, `params`). `GET /players?sort=recent` ordena por actividad reciente. Servidor: `CRM_PROVIDERS_LIVE=1` desactiva el transporte simulado.

## Contenido en el sitio (F3)

| Método y ruta | Permiso | Descripción |
|---|---|---|
| `GET /onsite/campaigns` | `onsite.read` | Campañas con estado, vigencia y métricas (impresiones, jugadores, clics, CTR, descartes) |
| `POST /onsite/campaigns` | `journeys.draft` | Borrador: `{ id, name, placement, purpose, rules, content: { es: { title, body, cta_label?, cta_url? } }, priority, starts_at, ends_at, max_impressions_per_day, dismiss_days? }` |
| `POST /onsite/campaigns/:id/submit` · `approve` · `pause` · `resume` | `journeys.submit` · `journeys.approve` · `journeys.pause` | Ciclo de aprobación (autor ≠ aprobador) |
| `GET /onsite/serve/:player?placement=&request_id=&locale=` | `players.read` (en producción, credencial de servicio del sitio) | Contenido a mostrar o `null` con los motivos de lo no mostrado; registra la impresión |
| `POST /onsite/events/:player` | `players.read` | `{ campaign_id, type: click \| dismiss, request_id }`, idempotente |

## Plantillas con IA y moderación (E6)

| Método y ruta | Permiso | Descripción |
|---|---|---|
| `GET /content/drafts` | `content.read` | Borradores con moderación y si la IA está habilitada |
| `POST /content/drafts` | `journeys.draft` | `{ key, goal, purpose, tone?, locales, vars, include_sms? }` → borrador (Claude o texto base) ya moderado |
| `POST /content/moderate` | `journeys.draft` | Revisa textos sin guardar: `{ texts, purpose, vars }` |
| `POST /content/drafts/:id/edit` · `submit` | `journeys.draft` · `journeys.submit` | Edición humana con nueva revisión; envío solo sin bloqueos |
| `POST /content/drafts/:id/approve` · `reject` | `journeys.approve` | Otra persona aprueba (crea la plantilla) o rechaza con motivo |

Servidor: con `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` o un perfil `ant` se habilita el escritor con Claude (`CONTENT_MODEL`, por defecto `claude-opus-5-5`, con respaldo del servidor ante rechazos). La versión estática nunca incluye el SDK.

## Políticas por mercado (I3)

| Método y ruta | Permiso | Descripción |
|---|---|---|
| `GET /policies` | `policy.read` | Políticas vigentes con historial y propuestas |
| `POST /policies/proposals` | `policy.propose` | `{ policy, justification? }`; justificación obligatoria si relaja una protección |
| `POST /policies/proposals/:id/approve` · `reject` | `journeys.approve` | Otra persona aprueba (se aplica) o rechaza con motivo; propuesta obsoleta si cambió la versión base |

## Impacto, fuentes y CSV (H4, H5, H6)

| Método y ruta | Permiso | Descripción |
|---|---|---|
| `GET /analytics/journey-impact?window=14` | `analytics.read` | Ranking de recorridos por NGR incremental tras la entrada vs. control, con IC 95 %, ROI y valoración de recompensas; `&format=csv` descarga |
| `GET /analytics/sources?days=30` | `performance.read` | Calidad temprana por fuente con veredicto y motivos; `&format=csv` descarga |

`GET /analytics/campaigns` ahora mide «depósito en 14 días tras entrar» (`deposito_14d_tras_entrar`) en lugar de «alguna vez depositó». Las respuestas CSV llevan `content-type: text/csv` y nombre de archivo.

## Lotes CSV, marcas y latencia (B2, B3, B4)

| Método y ruta | Permiso | Descripción |
|---|---|---|
| `POST /ingest/csv` | `ingest.csv` | `{ event_type, csv, dry_run = true, mode: historico \| tiempo_real, brand_id? }`; todo o nada, errores por línea, idempotente al resubir |
| `GET /brands` | — | Marcas del tenant con número de jugadores |

`?brand=` filtra `GET /players`, `/journeys`, `/performance`, `/performance/payback` y `/control-tower`. `GET /control-tower` incluye `latency` (n, p50/p95/p99/max en ms, retraso de llegada p95, por tipo de evento, objetivo 250 ms).

## Webhooks salientes y bus (J2, J3)

| Método y ruta | Permiso | Descripción |
|---|---|---|
| `GET /webhooks` | `integration.read` | Suscripciones (sin secreto), conteos de entregas, entregas recientes y temas del bus |
| `POST /webhooks` | `integration.sync` | `{ url, events, description? }` → devuelve el secreto una sola vez |
| `POST /webhooks/:id/pause` · `resume` · `rotate` | `integration.sync` | Pausa, reactiva o rota el secreto |
| `POST /webhooks/deliveries/:id/retry` | `integration.sync` | Reprograma una entrega rechazada o agotada |
| `POST /webhooks/dispatch` | `integration.sync` | Envía lo pendiente (el servidor lo hace cada 10 s) |

Cabeceras de cada entrega: `X-SS1-CRM-Event`, `X-SS1-CRM-Delivery` (id para deduplicar) y `X-SS1-CRM-Signature: t=<seg>,v1=<HMAC-SHA256(secreto, "<t>.<cuerpo>")>`. En el servidor, `CRM_PROVIDERS_LIVE=1` usa transporte HTTP real (10 s de espera, sin redirecciones).

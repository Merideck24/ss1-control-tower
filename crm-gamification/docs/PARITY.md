# Paridad con Fast Track CRM, GR8 CRM y Optimove

Fuentes leídas el 23-11-2026: fasttrack.ai/es/fast-track-crm, gr8.tech/es/crm, optimove.com/es y sus páginas Orchestrate, Engage y Gamify. La página iGaming de Optimove devolvió 404. Referencias: FT = Fast Track, GR8 = GR8 Tech, OPT = Optimove.

**Estados:** ✅ hecho y probado · 🟡 parcial · ⬜ pendiente (construible en este repo) · 🔒 bloqueado (requiere proveedor, credenciales o infraestructura externa; no se simula como hecho).

**Condición de término del loop:** no quedan filas ⬜ ni 🟡 construibles. Cada iteración toma la primera fila pendiente según el orden de prioridad, la implementa con pruebas, actualiza esta tabla y publica.

## A. Integración con admin.syssoft1.com (ecosistema SS1)

Hallazgos del admin: Vue 3 + Vuetify (plantilla Vuexy), autorización con CASL (`action`/`subject` por ruta), API `https://api.syssoft1.com` con `Authorization: Bearer <accessToken>` y `Accept-Language`. Módulos existentes relacionados: `/dashboard/crm`, `/loyalty`, `/bonus-campaigns` (+ asistente y catálogo de disparadores `/admin/bonus-campaigns/trigger-catalog`), `/telegram-campaigns` (+ IA), `/alerts` (+ reglas y canales), `/kyc`, `/players`, `/roles`, `/reports/audit-logs`, `/admin/theme-config`. Las rutas `/admin/*` exigen el token del usuario (401 sin él).

| # | Capacidad | Estado | Prioridad |
|---|---|---|---|
| A1 | Modo embebido: el CRM se muestra dentro del admin (sin su propio menú) y recibe sesión por `postMessage` con lista de orígenes permitidos | ✅ | 1 |
| A2 | Identidad SS1: el servidor valida el token del admin contra `api.syssoft1.com` y mapea roles/permisos CASL a roles del CRM; cabeceras de desarrollo solo con bandera explícita | ✅ | 2 |
| A3 | Cliente de la API SS1 y conectores de sincronización (jugadores, transacciones, estadísticas, catálogo de disparadores de bonos) que generan eventos normalizados | ✅ | 3 |
| A4 | Webhook de ingesta firmado (HMAC) para que el PAM empuje eventos en tiempo real | ✅ | 4 |
| A5 | Tema del tenant desde `/admin/theme-config` (color primario y logo) | ⬜ | 5 |
| A6 | Kit de integración para el repo del admin: ruta, ítem de menú, sujeto CASL `crm` y componente contenedor Vue | ⬜ | 6 |
| A7 | Conexión real con datos de producción | 🔒 | requiere token de un usuario del admin y acuerdo de contratos de eventos |

## B. Datos y vista única

| # | Capacidad | Referencia | Estado |
|---|---|---|---|
| B1 | Perfil 360 actualizado por eventos, con procedencia por campo | FT, OPT | ✅ |
| B2 | Ingesta en tiempo real y en lote (API + CSV) | FT, OPT | 🟡 (API sí; carga CSV ⬜) |
| B3 | Multimarca con filtro por marca | FT | 🟡 (modelo sí; filtro en UI ⬜) |
| B4 | Latencia evento→decisión medida (p95) y visible en Control Tower | FT | ⬜ |

## C. Segmentación

| # | Capacidad | Referencia | Estado |
|---|---|---|---|
| C1 | Segmentos dinámicos AND/OR/NOT con exclusiones y snapshot | FT, OPT | ✅ |
| C2 | RFM (recencia, frecuencia, valor) | GR8 | ⬜ |
| C3 | Etapas de ciclo de vida (nuevo, activo, en riesgo, inactivo, reactivado) | OPT, FT | ⬜ |
| C4 | Personas dinámicas (clusters por comportamiento y producto preferido) | FT | ⬜ |
| C5 | Segmentación por valor previsto y riesgo de abandono | OPT, GR8 | ⬜ (depende de E1–E2) |

## D. Journeys y automatización

| # | Capacidad | Referencia | Estado |
|---|---|---|---|
| D1 | Journeys sin código con versionado, aprobación, simulación y pausa | FT, GR8, OPT | ✅ |
| D2 | Constructor visual (lienzo con nodos y conexiones, sin JSON) | FT, GR8, OPT | ⬜ |
| D3 | Anti-solapamiento entre journeys (prioridad y bloqueo de colisión) | GR8 | ⬜ |
| D4 | Control de frecuencia por canal | FT | 🟡 (tope global ✅; por canal ⬜) |
| D5 | A/B/n en journeys y optimización automática (bandit) | OPT, GR8 | ⬜ |
| D6 | Journeys de juego responsable (intervención, no promoción) | FT | ⬜ (depende de G1) |

## E. Personalización e IA

| # | Capacidad | Referencia | Estado |
|---|---|---|---|
| E1 | Predicción de abandono (score explicable, validación temporal) | FT, OPT | ⬜ |
| E2 | Valor previsto (LTV) y detección temprana de VIP | FT, OPT | ⬜ |
| E3 | Propensión al depósito | FT | ⬜ |
| E4 | Mejor acción siguiente con opción «no contactar» y exclusión por política | FT, OPT | ⬜ |
| E5 | Preferencias de conducta (producto y juego preferidos) | FT, OPT | ⬜ |
| E6 | Generación de contenido con IA para plantillas (borrador) y moderación | FT, OPT | ⬜ |
| E7 | Copiloto en lenguaje natural con herramientas tipadas | FT | ✅ |
| E8 | Agentes que ejecutan campañas de forma autónoma | FT, OPT | 🔒 (el plan exige aprobación humana; no se habilita ejecución autónoma) |

## F. Canales

| # | Capacidad | Referencia | Estado |
|---|---|---|---|
| F1 | In-app, email, web push con recibos | FT, GR8, OPT | ✅ (adaptadores simulados) |
| F2 | SMS, WhatsApp y Telegram (adaptadores; Telegram alineado con `/telegram-campaigns` del admin) | FT, GR8, OPT | ⬜ |
| F3 | Popups, banners y contenido on-site por segmento | FT, GR8, OPT | ⬜ |
| F4 | Centro de notificaciones del jugador (bandeja) | GR8 | ⬜ |
| F5 | Proveedores reales (20+ SMS/email, redes publicitarias) | FT, OPT | 🔒 |

## G. Gamificación, bonos y recompensas

| # | Capacidad | Referencia | Estado |
|---|---|---|---|
| G1 | Niveles, puntos, aviso del 50 %, reversos compensatorios | GR8, OPT | ✅ |
| G2 | Misiones/retos con progreso y recompensa | FT, GR8, OPT | ⬜ |
| G3 | Logros e insignias | GR8, OPT | ⬜ |
| G4 | Torneos con ranking reproducible | FT, GR8, OPT | ⬜ |
| G5 | Mini-juegos: ruleta y caja de premios aleatoria con probabilidades auditables | GR8, OPT | ⬜ |
| G6 | Tienda de canjes con moneda propia, saldo y stock bajo concurrencia | GR8, OPT | ⬜ |
| G7 | Juegos de predicción con bonos por acierto | GR8 | ⬜ |
| G8 | Presupuesto y límites de gasto de recompensas | OPT | ✅ |
| G9 | Detección de abuso de bonos y escalado por conducta | FT (Greco) | ⬜ |
| G10 | Preferencia del jugador para desactivar gamificación (persistente) | Plan CRM-10 | 🟡 (servicio ✅; UI y API ⬜) |

## H. Medición

| # | Capacidad | Referencia | Estado |
|---|---|---|---|
| H1 | Grupos de control, incremento con IC 95 % | FT, OPT | ✅ |
| H2 | ROI, CPA, costo por FTD, NGR, retención, payback por cohorte | FT, OPT | ✅ |
| H3 | Alertas de KPI con significancia | FT | ✅ |
| H4 | Ranking de journeys y recompensas por NGR, retención y ROI | FT | ⬜ |
| H5 | Evaluación temprana de afiliados por calidad de jugadores | FT, OPT | ⬜ |
| H6 | Exportación CSV de tablas | — | ⬜ |

## I. Compliance y juego responsable

| # | Capacidad | Referencia | Estado |
|---|---|---|---|
| I1 | Consentimiento por propósito y canal, supresión fail-closed, auditoría encadenada | FT | ✅ |
| I2 | Monitoreo de riesgo en tiempo real (velocidad de depósito, persecución de pérdidas, sesiones nocturnas) con señales para el equipo JR | FT | ⬜ |
| I3 | Topes jurisdiccionales editables por mercado desde la UI (con aprobación) | FT | ⬜ |
| I4 | Certificaciones GDPR / SOC | FT | 🔒 |

## J. Integraciones técnicas

| # | Capacidad | Referencia | Estado |
|---|---|---|---|
| J1 | API REST de eventos | FT, OPT | ✅ |
| J2 | Webhooks salientes firmados (decisiones y entregas) | FT | ⬜ |
| J3 | Kafka / RabbitMQ | FT | 🔒 (interfaz de adaptador ⬜ con A3) |

## Orden de las iteraciones

1. A1 → A2 → A3 → A4 → A5 → A6 (integración con el admin, pedido explícito)
2. C2, C3 (RFM y ciclo de vida) → E1, E2, E3, E5 (modelos explicables) → C4, C5 → E4 (mejor acción siguiente)
3. G2, G3, G4, G5, G6, G7, G10 (gamificación) → G9
4. D2 (constructor visual) → D3, D4, D5 → D6 con I2
5. F2, F3, F4 → E6
6. I2, I3 → H4, H5, H6 → B2, B3, B4 → J2

## Registro de iteraciones

| Iteración | Fecha | Filas | Resultado |
|---|---|---|---|
| 0 | 2026-11-23 | — | Matriz creada a partir de las páginas de los tres proveedores y del bundle del admin |
| 1 | 2026-11-23 | A1 | Modo embebido con protocolo `postMessage` v1, validación de origen, mapeo CASL → roles (`src/integration/ss1Auth.ts`), orígenes por despliegue. Prueba de dos orígenes: el admin autorizado entra, uno no autorizado es ignorado. Ver `docs/INTEGRATION.md` |
| 2 | 2026-11-23 | A2 | El servidor valida el token del admin contra `api.syssoft1.com`, mapea operador → tenant y CASL → roles, ignora `x-roles` del navegador, cachea por hash del token; sin token ni `CRM_DEV_AUTH=1` responde 401. Pendiente confirmar el endpoint de perfil con el equipo del admin |
| 3 | 2026-11-23 | A3 | Cliente de la API del admin (reintentos, paginación Laravel), conectores de jugadores, transacciones y retiros con `event_id` deterministas, nuevo evento `withdrawal.settled`, catálogo de disparadores, sincronización `backfill` sin efectos y `live`. Corregido un fallo del paquete de navegador y añadida una prueba que lo carga sin APIs de Node |
| 4 | 2026-11-23 | A4 | `POST /api/ingest/ss1` con firma HMAC-SHA256 por tenant, ventana de ±300 s, comparación en tiempo constante, lotes de hasta 500 eventos, aislamiento por tenant y reenvíos idempotentes; ejemplo de envío en Laravel |

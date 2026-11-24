/**
 * Catálogo de la API: una entrada por ruta del enrutador. Es la fuente de:
 *  · la especificación OpenAPI (contracts/openapi.json),
 *  · el control de las llaves de servicio (máquina a máquina): una llave solo llega a
 *    rutas cuyo `scope` tenga; las rutas sin `scope` son solo para personas.
 * Una prueba compara este catálogo con las rutas reales del enrutador y falla si
 * alguna ruta queda sin documentar o sobra una entrada.
 */
export const SCOPES = {
  'events:write': 'Enviar eventos (tiempo real y lotes CSV)',
  'players:read': 'Leer perfiles, bandeja y marcas',
  'players:write': 'Acciones del jugador desde el sitio: bandeja, preferencias, canjes, giros, predicciones',
  'onsite:serve': 'Pedir contenido en el sitio y registrar impresiones/clics',
  'analytics:read': 'Control Tower, rendimiento, modelos, alertas e informes',
  'journeys:read': 'Leer recorridos, recompensas y definiciones de gamificación',
  'segments:read': 'Previsualizar segmentos',
  'rg:read': 'Leer la cola de juego responsable',
  'abuse:read': 'Leer el riesgo de abuso de bonos',
  'policies:read': 'Leer políticas por mercado',
  'audit:read': 'Exportar la auditoría (SIEM)',
  'webhooks:manage': 'Gestionar webhooks salientes',
} as const;
export type Scope = keyof typeof SCOPES;

export type Endpoint = {
  /** Patrón tal como aparece en el enrutador (método + ruta o expresión). */
  route: string;
  /** Nombres de los grupos capturados, en orden. Las alternativas (a|b) se documentan como enum. */
  params?: string[];
  tag: string;
  summary: string;
  /** Permiso de rol exigido a personas (null: cualquier usuario autenticado del tenant). */
  perm: string | string[] | null;
  /** Alcance exigido a llaves de servicio (null: no disponible para llaves). */
  scope: Scope | null;
  query?: string[];
  body?: string;
};

const e = (route: string, tag: string, summary: string, perm: Endpoint['perm'], scope: Endpoint['scope'], extra: Partial<Endpoint> = {}): Endpoint => ({ route, tag, summary, perm, scope, ...extra });

export const CATALOG: Endpoint[] = [
  // Sesión y operación
  e('GET /health', 'Operación', 'Estado del servicio (sin autenticación)', null, null),
  e('GET /session', 'Operación', 'Sesión actual: actor, permisos y herramientas del copiloto', null, null),
  e('GET /brands', 'Operación', 'Marcas del tenant con número de jugadores', null, 'players:read'),
  e('GET /control-tower', 'Operación', 'Estado operativo: entregas, supresiones, recorridos, latencia', null, 'analytics:read', { query: ['brand'] }),
  e('POST /runtime/tick', 'Operación', 'Procesar esperas vencidas', 'runtime.tick', null),
  e('POST /runtime/pause', 'Operación', 'Pausa o reanudación general de envíos', 'runtime.global_pause', null, { body: '{ paused: boolean, reason }' }),
  // Ingesta
  e('POST /events', 'Ingesta', 'Enviar un evento normalizado (contracts/events.asyncapi.yaml)', 'events.write', 'events:write', { body: 'EventEnvelope' }),
  e('POST /ingest/csv', 'Ingesta', 'Carga por lotes CSV (todo o nada, idempotente)', 'ingest.csv', 'events:write', { body: '{ event_type, csv, dry_run, mode, brand_id }' }),
  // Jugadores
  e('GET /players', 'Jugadores', 'Buscar jugadores', 'players.read', 'players:read', { query: ['q', 'brand', 'sort'] }),
  e('GET /players/([\\w-]+)', 'Jugadores', 'Perfil 360 con procedencia, elegibilidad, segmentación y riesgo', 'players.read', 'players:read', { params: ['player_id'] }),
  e('GET /players/([\\w-]+)/inbox', 'Jugadores', 'Bandeja del jugador', 'players.read', 'players:read', { params: ['player_id'], query: ['archived'] }),
  e('POST /players/([\\w-]+)/inbox/read-all', 'Jugadores', 'Marcar toda la bandeja como leída', 'player.preferences', 'players:write', { params: ['player_id'] }),
  e('POST /players/([\\w-]+)/inbox/([^/]+)/(read|archive)', 'Jugadores', 'Marcar un mensaje como leído o archivarlo', 'player.preferences', 'players:write', { params: ['player_id', 'message_id', 'action'] }),
  e('POST /players/([\\w-]+)/gamification-preference', 'Jugadores', 'Activar o desactivar la gamificación del jugador', 'player.preferences', 'players:write', { params: ['player_id'], body: '{ opt_out: boolean }' }),
  e('POST /players/([\\w-]+)/coins', 'Jugadores', 'Ajuste manual de monedas (auditado)', 'alerts.configure', null, { params: ['player_id'], body: '{ amount, reason, request_id }' }),
  // Segmentos y modelos
  e('GET /segments/fields', 'Segmentos', 'Campos disponibles para reglas', null, 'analytics:read'),
  e('POST /segments/preview', 'Segmentos', 'Previsualizar un segmento', 'segments.preview', 'segments:read', { body: '{ rules, exclusions? }' }),
  e('GET /segments/rfm', 'Segmentos', 'Distribución RFM y ciclo de vida', 'segments.preview', 'analytics:read'),
  e('GET /personas', 'Segmentos', 'Personas (k-means)', 'segments.preview', 'analytics:read'),
  e('GET /models', 'Analítica', 'Modelos predictivos y su validación', 'analytics.read', 'analytics:read'),
  e('GET /nba/summary', 'Analítica', 'Mejor acción siguiente: resumen', 'analytics.read', 'analytics:read'),
  // Recorridos
  e('GET /journeys', 'Recorridos', 'Versiones de recorridos con validación', null, 'journeys:read', { query: ['brand'] }),
  e('POST /journeys', 'Recorridos', 'Guardar borrador', 'journeys.draft', null, { body: 'JourneyDefinition' }),
  e('GET /journeys/builder', 'Recorridos', 'Catálogo del constructor visual', 'journeys.draft', null),
  e('POST /journeys/review', 'Recorridos', 'Revisión en vivo de un borrador', 'journeys.draft', null, { body: 'JourneyDefinition' }),
  e('GET /journeys/overlap', 'Recorridos', 'Grupos de solapamiento, bloqueos y riesgos', null, 'analytics:read'),
  e('POST /journeys/([\\w-]+)/(submit|approve|publish|pause|resume)', 'Recorridos', 'Ciclo de aprobación y publicación', ['journeys.submit', 'journeys.approve', 'journeys.publish', 'journeys.pause'], null, { params: ['journey_id', 'action'] }),
  e('POST /journeys/([\\w-]+)/simulate', 'Recorridos', 'Simular sin efectos', 'journeys.simulate', null, { params: ['journey_id'], body: '{ player_id, payload }' }),
  e('GET /experiments/splits', 'Analítica', 'Experimentos A/B/n', 'analytics.read', 'analytics:read'),
  // Analítica y rendimiento
  e('GET /analytics/campaigns', 'Analítica', 'Tratamiento vs. control por recorrido', 'analytics.read', 'analytics:read'),
  e('GET /analytics/journey-impact', 'Analítica', 'Ranking de recorridos por NGR incremental', 'analytics.read', 'analytics:read', { query: ['window', 'format'] }),
  e('GET /analytics/sources', 'Analítica', 'Calidad de fuentes de adquisición', 'performance.read', 'analytics:read', { query: ['days', 'format'] }),
  e('GET /channels/status', 'Analítica', 'Entregas por canal y bandeja', 'analytics.read', 'analytics:read'),
  e('GET /performance', 'Rendimiento', 'Adquisición y finanzas por campaña', 'performance.read', 'analytics:read', { query: ['days', 'brand'] }),
  e('GET /performance/payback', 'Rendimiento', 'Payback por cohorte', 'performance.read', 'analytics:read', { query: ['weeks', 'brand'] }),
  e('GET /kpi-alerts', 'Rendimiento', 'Alertas de KPI', 'alerts.read', 'analytics:read'),
  e('POST /kpi-alerts/([\\w:.-]+)/ack', 'Rendimiento', 'Reconocer una alerta', 'alerts.ack', null, { params: ['alert_id'] }),
  e('PUT /kpi-alerts/config', 'Rendimiento', 'Configurar umbrales de alertas', 'alerts.configure', null),
  // Recompensas
  e('GET /rewards', 'Recompensas', 'Catálogo, presupuestos y otorgamientos recientes', null, 'journeys:read'),
  e('POST /rewards/reconcile', 'Recompensas', 'Conciliar con el servicio de bonos', 'rewards.reconcile', null),
  // Gamificación
  e('GET /gamification/missions', 'Gamificación', 'Misiones y estadísticas', 'gamification.read', 'journeys:read'),
  e('POST /gamification/missions', 'Gamificación', 'Guardar misión', 'journeys.draft', null),
  e('POST /gamification/missions/([\\w-]+)/(activate|pause)', 'Gamificación', 'Activar o pausar misión', ['journeys.submit', 'journeys.approve', 'journeys.pause'], null, { params: ['mission_id', 'action'] }),
  e('GET /gamification/tournaments', 'Gamificación', 'Torneos y clasificaciones', 'gamification.read', 'journeys:read'),
  e('POST /gamification/tournaments', 'Gamificación', 'Guardar torneo', 'journeys.draft', null),
  e('POST /gamification/tournaments/([\\w-]+)/(activate|finalize)', 'Gamificación', 'Activar o cerrar torneo', ['journeys.submit', 'journeys.approve'], null, { params: ['tournament_id', 'action'] }),
  e('GET /gamification/minigames', 'Gamificación', 'Mini-juegos', 'gamification.read', 'journeys:read'),
  e('GET /gamification/minigames/([\\w-]+)/verify', 'Gamificación', 'Verificar resultados con la semilla revelada', null, 'journeys:read', { params: ['game_id'], query: ['seed', 'player_id', 'nonce'] }),
  e('POST /gamification/minigames/([\\w-]+)/(spin|rotate-seed)', 'Gamificación', 'Girar (jugador) o rotar semilla (admin)', ['player.preferences', 'alerts.configure'], 'players:write', { params: ['game_id', 'action'] }),
  e('GET /gamification/store', 'Gamificación', 'Tienda y predicciones', 'gamification.read', 'journeys:read'),
  e('POST /gamification/store/items', 'Gamificación', 'Guardar artículo de la tienda', 'alerts.configure', null),
  e('POST /gamification/store/redeem', 'Gamificación', 'Canjear (idempotente por request_id)', 'player.preferences', 'players:write', { body: '{ player_id, item_id, request_id }' }),
  e('POST /gamification/predictions', 'Gamificación', 'Guardar predicción', 'journeys.draft', null),
  e('POST /gamification/predictions/([\\w-]+)/(pick|resolve)', 'Gamificación', 'Elegir (jugador) o resolver (aprobador)', ['player.preferences', 'journeys.approve'], 'players:write', { params: ['prediction_id', 'action'] }),
  // Riesgo
  e('GET /risk/bonus-abuse', 'Riesgo', 'Abuso de bonos', 'abuse.read', 'abuse:read'),
  e('POST /risk/bonus-abuse/([\\w-]+)/review', 'Riesgo', 'Revisión humana de abuso', 'abuse.review', null, { params: ['player_id'] }),
  e('GET /risk/rg-monitor', 'Riesgo', 'Cola de juego responsable', 'rg.monitor', 'rg:read'),
  e('POST /risk/rg-cases/([\\w:.-]+)/(take|close)', 'Riesgo', 'Tomar o cerrar un caso', 'rg.act', null, { params: ['case_id', 'action'] }),
  // Contenido
  e('GET /content/drafts', 'Contenido', 'Borradores de plantillas', 'content.read', null),
  e('POST /content/drafts', 'Contenido', 'Pedir borrador (IA o texto base)', 'journeys.draft', null),
  e('POST /content/moderate', 'Contenido', 'Moderar textos sin guardar', 'journeys.draft', null),
  e('POST /content/drafts/([\\w-]+)/(edit|submit|approve|reject)', 'Contenido', 'Editar, enviar, aprobar o rechazar', ['journeys.draft', 'journeys.submit', 'journeys.approve'], null, { params: ['draft_id', 'action'] }),
  // Contenido en sitio
  e('GET /onsite/campaigns', 'Sitio', 'Campañas en el sitio y métricas', 'onsite.read', 'analytics:read'),
  e('POST /onsite/campaigns', 'Sitio', 'Guardar campaña', 'journeys.draft', null),
  e('POST /onsite/campaigns/([\\w-]+)/(submit|approve|pause|resume)', 'Sitio', 'Ciclo de aprobación', ['journeys.submit', 'journeys.approve', 'journeys.pause'], null, { params: ['campaign_id', 'action'] }),
  e('GET /onsite/serve/([\\w-]+)', 'Sitio', 'Contenido a mostrar al jugador en una ubicación', 'players.read', 'onsite:serve', { params: ['player_id'], query: ['placement', 'request_id', 'locale'] }),
  e('POST /onsite/events/([\\w-]+)', 'Sitio', 'Registrar clic o descarte', 'players.read', 'onsite:serve', { params: ['player_id'], body: '{ campaign_id, type, request_id }' }),
  // Políticas
  e('GET /policies', 'Políticas', 'Políticas vigentes, historial y propuestas', 'policy.read', 'policies:read'),
  e('POST /policies/proposals', 'Políticas', 'Proponer cambios', 'policy.propose', null),
  e('POST /policies/proposals/([\\w.-]+)/(approve|reject)', 'Políticas', 'Aprobar o rechazar', 'journeys.approve', null, { params: ['proposal_id', 'action'] }),
  // Integración
  e('GET /integration/ss1/theme', 'Integración', 'Tema del admin (colores y logo)', null, null),
  e('GET /integration/ss1/trigger-catalog', 'Integración', 'Catálogo de disparadores del admin', 'integration.read', null),
  e('POST /integration/ss1/sync', 'Integración', 'Sincronizar datos desde el admin', 'integration.sync', null),
  e('GET /integration/service-keys', 'Integración', 'Llaves de servicio (sin secretos)', 'integration.read', null),
  e('POST /integration/service-keys', 'Integración', 'Crear llave de servicio (el secreto se muestra una vez)', 'integration.sync', null, { body: '{ name, scopes }' }),
  e('POST /integration/service-keys/([\\w-]+)/revoke', 'Integración', 'Revocar llave de servicio', 'integration.sync', null, { params: ['key_id'] }),
  e('GET /openapi.json', 'Integración', 'Esta especificación', null, null),
  e('GET /webhooks', 'Integración', 'Webhooks salientes', 'integration.read', 'webhooks:manage'),
  e('POST /webhooks', 'Integración', 'Crear suscripción', 'integration.sync', 'webhooks:manage', { body: '{ url, events, description? }' }),
  e('POST /webhooks/([\\w-]+)/(pause|resume|rotate)', 'Integración', 'Pausar, reactivar o rotar secreto', 'integration.sync', 'webhooks:manage', { params: ['subscription_id', 'action'] }),
  e('POST /webhooks/deliveries/([\\w-]+)/retry', 'Integración', 'Reintentar entrega', 'integration.sync', 'webhooks:manage', { params: ['delivery_id'] }),
  e('POST /webhooks/dispatch', 'Integración', 'Enviar entregas pendientes', 'integration.sync', 'webhooks:manage'),
  // Copiloto y auditoría
  e('GET /copilot/tools', 'Copiloto', 'Herramientas disponibles para el rol', null, null),
  e('POST /copilot/tools/(\\w+)', 'Copiloto', 'Ejecutar herramienta', null, null, { params: ['tool'] }),
  e('POST /copilot/ask', 'Copiloto', 'Pregunta en lenguaje natural (Claude)', null, null),
  e('GET /audit', 'Auditoría', 'Registro de auditoría encadenado', 'audit.read', 'audit:read'),
];

const compiled = CATALOG.map((x) => { const [method, pattern] = x.route.split(' '); return { entry: x, method, re: new RegExp(`^${pattern}$`) }; });
/** Busca la entrada del catálogo para una petición (método + ruta sin /api). */
export function findEndpoint(method: string, path: string): Endpoint | undefined {
  return compiled.find((c) => c.method === method && c.re.test(path))?.entry;
}

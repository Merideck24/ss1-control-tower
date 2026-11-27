// Generado por `npm run admin:client` desde src/api/catalog.ts. No editar a mano.
/* eslint-disable */
export type Op<P> = { method: 'GET' | 'POST' | 'PUT'; path: string; params: readonly string[]; query: readonly string[]; __params?: P };

export const CRM_ENDPOINTS = {
  /** Estado del servicio (sin autenticación) */
  getHealth: { method: 'GET', path: '/health', params: [] as const, query: [] as const } as Op<{  }>,
  /** Sesión actual: actor, permisos y herramientas del copiloto */
  getSession: { method: 'GET', path: '/session', params: [] as const, query: [] as const } as Op<{  }>,
  /** Marcas del tenant con número de jugadores · alcance players:read */
  getBrands: { method: 'GET', path: '/brands', params: [] as const, query: [] as const } as Op<{  }>,
  /** Estado operativo: entregas, supresiones, recorridos, latencia · alcance analytics:read */
  getControlTower: { method: 'GET', path: '/control-tower', params: [] as const, query: ['brand'] as const } as Op<{  }>,
  /** Procesar esperas vencidas */
  postRuntimeTick: { method: 'POST', path: '/runtime/tick', params: [] as const, query: [] as const } as Op<{  }>,
  /** Pausa o reanudación general de envíos */
  postRuntimePause: { method: 'POST', path: '/runtime/pause', params: [] as const, query: [] as const } as Op<{  }>,
  /** Enviar un evento normalizado (contracts/events.asyncapi.yaml) · alcance events:write */
  postEvents: { method: 'POST', path: '/events', params: [] as const, query: [] as const } as Op<{  }>,
  /** Carga por lotes CSV (todo o nada, idempotente) · alcance events:write */
  postIngestCsv: { method: 'POST', path: '/ingest/csv', params: [] as const, query: [] as const } as Op<{  }>,
  /** Buscar jugadores · alcance players:read */
  getPlayers: { method: 'GET', path: '/players', params: [] as const, query: ['q', 'brand', 'sort'] as const } as Op<{  }>,
  /** Perfil 360 con procedencia, elegibilidad, segmentación y riesgo · alcance players:read */
  getPlayersPlayerId: { method: 'GET', path: '/players/{player_id}', params: ['player_id'] as const, query: [] as const } as Op<{ player_id: string }>,
  /** Bandeja del jugador · alcance players:read */
  getPlayersPlayerIdInbox: { method: 'GET', path: '/players/{player_id}/inbox', params: ['player_id'] as const, query: ['archived'] as const } as Op<{ player_id: string }>,
  /** Marcar toda la bandeja como leída · alcance players:write */
  postPlayersPlayerIdInboxReadAll: { method: 'POST', path: '/players/{player_id}/inbox/read-all', params: ['player_id'] as const, query: [] as const } as Op<{ player_id: string }>,
  /** Marcar un mensaje como leído o archivarlo · alcance players:write */
  postPlayersPlayerIdInboxMessageIdAction: { method: 'POST', path: '/players/{player_id}/inbox/{message_id}/{action}', params: ['player_id', 'message_id', 'action'] as const, query: [] as const } as Op<{ player_id: string; message_id: string; action: 'read' | 'archive' }>,
  /** Activar o desactivar la gamificación del jugador · alcance players:write */
  postPlayersPlayerIdGamificationPreference: { method: 'POST', path: '/players/{player_id}/gamification-preference', params: ['player_id'] as const, query: [] as const } as Op<{ player_id: string }>,
  /** Ajuste manual de monedas (auditado) */
  postPlayersPlayerIdCoins: { method: 'POST', path: '/players/{player_id}/coins', params: ['player_id'] as const, query: [] as const } as Op<{ player_id: string }>,
  /** Campos disponibles para reglas · alcance analytics:read */
  getSegmentsFields: { method: 'GET', path: '/segments/fields', params: [] as const, query: [] as const } as Op<{  }>,
  /** Previsualizar un segmento · alcance segments:read */
  postSegmentsPreview: { method: 'POST', path: '/segments/preview', params: [] as const, query: [] as const } as Op<{  }>,
  /** Distribución RFM y ciclo de vida · alcance analytics:read */
  getSegmentsRfm: { method: 'GET', path: '/segments/rfm', params: [] as const, query: [] as const } as Op<{  }>,
  /** Personas (k-means) · alcance analytics:read */
  getPersonas: { method: 'GET', path: '/personas', params: [] as const, query: [] as const } as Op<{  }>,
  /** Modelos predictivos y su validación · alcance analytics:read */
  getModels: { method: 'GET', path: '/models', params: [] as const, query: [] as const } as Op<{  }>,
  /** Mejor acción siguiente: resumen · alcance analytics:read */
  getNbaSummary: { method: 'GET', path: '/nba/summary', params: [] as const, query: [] as const } as Op<{  }>,
  /** Versiones de recorridos con validación · alcance journeys:read */
  getJourneys: { method: 'GET', path: '/journeys', params: [] as const, query: ['brand'] as const } as Op<{  }>,
  /** Guardar borrador */
  postJourneys: { method: 'POST', path: '/journeys', params: [] as const, query: [] as const } as Op<{  }>,
  /** Catálogo del constructor visual */
  getJourneysBuilder: { method: 'GET', path: '/journeys/builder', params: [] as const, query: [] as const } as Op<{  }>,
  /** Revisión en vivo de un borrador */
  postJourneysReview: { method: 'POST', path: '/journeys/review', params: [] as const, query: [] as const } as Op<{  }>,
  /** Grupos de solapamiento, bloqueos y riesgos · alcance analytics:read */
  getJourneysOverlap: { method: 'GET', path: '/journeys/overlap', params: [] as const, query: [] as const } as Op<{  }>,
  /** Ciclo de aprobación, publicación, pausa y cierre */
  postJourneysJourneyIdAction: { method: 'POST', path: '/journeys/{journey_id}/{action}', params: ['journey_id', 'action'] as const, query: [] as const } as Op<{ journey_id: string; action: 'submit' | 'approve' | 'publish' | 'pause' | 'resume' | 'close' }>,
  /** Retos con métricas (elegibles, inscritos, inicio, finalización, recompensas) y definiciones · alcance journeys:read */
  getChallenges: { method: 'GET', path: '/challenges', params: [] as const, query: ['brand', 'status', 'market'] as const } as Op<{  }>,
  /** Guardar borrador de reto (valida salvaguardas de juego responsable) */
  postChallenges: { method: 'POST', path: '/challenges', params: [] as const, query: [] as const } as Op<{  }>,
  /** Versiones de un reto · alcance journeys:read */
  getChallengesChallengeId: { method: 'GET', path: '/challenges/{challenge_id}', params: ['challenge_id'] as const, query: [] as const } as Op<{ challenge_id: string }>,
  /** Ciclo: enviar, aprobar (otra persona), pausar, reanudar, cerrar con motivo */
  postChallengesChallengeIdAction: { method: 'POST', path: '/challenges/{challenge_id}/{action}', params: ['challenge_id', 'action'] as const, query: [] as const } as Op<{ challenge_id: string; action: 'submit' | 'approve' | 'pause' | 'resume' | 'close' }>,
  /** Simular un reto con eventos de ejemplo, sin efectos */
  postChallengesChallengeIdSimulate: { method: 'POST', path: '/challenges/{challenge_id}/simulate', params: ['challenge_id'] as const, query: [] as const } as Op<{ challenge_id: string }>,
  /** Regalos instantáneos con métricas (asignados, reclamados, en pausa, vencidos, recompensas) · alcance journeys:read */
  getGifts: { method: 'GET', path: '/gifts', params: [] as const, query: [] as const } as Op<{  }>,
  /** Guardar borrador de regalo (jugadores o segmento, cupo, vigencia) */
  postGifts: { method: 'POST', path: '/gifts', params: [] as const, query: [] as const } as Op<{  }>,
  /** Detalle de un regalo y sus asignaciones · alcance journeys:read */
  getGiftsGiftId: { method: 'GET', path: '/gifts/{gift_id}', params: ['gift_id'] as const, query: [] as const } as Op<{ gift_id: string }>,
  /** Ciclo: enviar, aprobar y asignar (otra persona), cerrar con motivo */
  postGiftsGiftIdAction: { method: 'POST', path: '/gifts/{gift_id}/{action}', params: ['gift_id', 'action'] as const, query: [] as const } as Op<{ gift_id: string; action: 'submit' | 'approve' | 'close' }>,
  /** Mis regalos: disponibles, reclamados, en pausa y vencidos · alcance players:write */
  getPlayersPlayerIdGifts: { method: 'GET', path: '/players/{player_id}/gifts', params: ['player_id'] as const, query: [] as const } as Op<{ player_id: string }>,
  /** Reclamar un regalo (única aunque llegue dos veces) · alcance players:write */
  postPlayersPlayerIdGiftsGiftIdClaim: { method: 'POST', path: '/players/{player_id}/gifts/{gift_id}/claim', params: ['player_id', 'gift_id'] as const, query: [] as const } as Op<{ player_id: string; gift_id: string }>,
  /** Catálogo de logros con niveles y condiciones · alcance journeys:read */
  getAchievementsCatalog: { method: 'GET', path: '/achievements/catalog', params: [] as const, query: [] as const } as Op<{  }>,
  /** Interacciones con tarjetas: clic, descarga, visita atribuida, publicación confirmada · alcance analytics:read */
  getGamificationShareMetrics: { method: 'GET', path: '/gamification/share-metrics', params: [] as const, query: [] as const } as Op<{  }>,
  /** Tarjeta compartida (pública, identificador opaco, revocable) */
  getPublicShareShareId: { method: 'GET', path: '/public/share/{share_id}', params: ['share_id'] as const, query: [] as const } as Op<{ share_id: string }>,
  /** Retos del jugador: disponibles, avance, condiciones, vigencia y recompensa · alcance players:write */
  getPlayersPlayerIdChallenges: { method: 'GET', path: '/players/{player_id}/challenges', params: ['player_id'] as const, query: [] as const } as Op<{ player_id: string }>,
  /** Inscribirse (voluntario), salir o cambiar avisos · alcance players:write */
  postPlayersPlayerIdChallengesChallengeIdAction: { method: 'POST', path: '/players/{player_id}/challenges/{challenge_id}/{action}', params: ['player_id', 'challenge_id', 'action'] as const, query: [] as const } as Op<{ player_id: string; challenge_id: string; action: 'enroll' | 'leave' | 'preferences' }>,
  /** «Mis logros», alias y enlaces compartidos · alcance players:write */
  getPlayersPlayerIdAchievements: { method: 'GET', path: '/players/{player_id}/achievements', params: ['player_id'] as const, query: [] as const } as Op<{ player_id: string }>,
  /** Alias público y permiso para mostrarlo en tarjetas · alcance players:write */
  postPlayersPlayerIdAlias: { method: 'POST', path: '/players/{player_id}/alias', params: ['player_id'] as const, query: [] as const } as Op<{ player_id: string }>,
  /** Vista previa de la tarjeta compartible (SVG) · alcance players:write */
  postPlayersPlayerIdAchievementsAchievementIdCard: { method: 'POST', path: '/players/{player_id}/achievements/{achievement_id}/card', params: ['player_id', 'achievement_id'] as const, query: [] as const } as Op<{ player_id: string; achievement_id: string }>,
  /** Crear enlace público (requiere confirm: true) · alcance players:write */
  postPlayersPlayerIdAchievementsAchievementIdShareLink: { method: 'POST', path: '/players/{player_id}/achievements/{achievement_id}/share-link', params: ['player_id', 'achievement_id'] as const, query: [] as const } as Op<{ player_id: string; achievement_id: string }>,
  /** Revocar un enlace público · alcance players:write */
  postPlayersPlayerIdShareLinksShareIdRevoke: { method: 'POST', path: '/players/{player_id}/share-links/{share_id}/revoke', params: ['player_id', 'share_id'] as const, query: [] as const } as Op<{ player_id: string; share_id: string }>,
  /** Registrar clic en compartir, descarga o publicación con evidencia · alcance players:write */
  postPlayersPlayerIdShareEvents: { method: 'POST', path: '/players/{player_id}/share-events', params: ['player_id'] as const, query: [] as const } as Op<{ player_id: string }>,
  /** Avisos en tiempo real desde un cursor (respaldo del canal SSE /players/:id/stream) · alcance players:write */
  getPlayersPlayerIdRealtime: { method: 'GET', path: '/players/{player_id}/realtime', params: ['player_id'] as const, query: ['after'] as const } as Op<{ player_id: string }>,
  /** Cola de fallas de entrega con filtros (marca, recorrido, canal, estado, motivo, fechas) · alcance analytics:read */
  getFailures: { method: 'GET', path: '/failures', params: [] as const, query: ['brand', 'journey', 'channel', 'status', 'reason', 'from', 'to', 'resolved'] as const } as Op<{  }>,
  /** Detalle de una falla con instrucciones e historial de reprocesos · alcance analytics:read */
  getFailuresIdempotencyKey: { method: 'GET', path: '/failures/{idempotency_key}', params: ['idempotency_key'] as const, query: [] as const } as Op<{ idempotency_key: string }>,
  /** Reprocesar una falla: concilia, revalida política y reenvía con la misma clave */
  postFailuresIdempotencyKeyReprocess: { method: 'POST', path: '/failures/{idempotency_key}/reprocess', params: ['idempotency_key'] as const, query: [] as const } as Op<{ idempotency_key: string }>,
  /** Seguimiento: instancias por estado y versión, supresiones con motivo y fallas · alcance analytics:read */
  getJourneysJourneyIdRuns: { method: 'GET', path: '/journeys/{journey_id}/runs', params: ['journey_id'] as const, query: [] as const } as Op<{ journey_id: string }>,
  /** Simular sin efectos */
  postJourneysJourneyIdSimulate: { method: 'POST', path: '/journeys/{journey_id}/simulate', params: ['journey_id'] as const, query: [] as const } as Op<{ journey_id: string }>,
  /** Experimentos A/B/n · alcance analytics:read */
  getExperimentsSplits: { method: 'GET', path: '/experiments/splits', params: [] as const, query: [] as const } as Op<{  }>,
  /** Tratamiento vs. control por recorrido · alcance analytics:read */
  getAnalyticsCampaigns: { method: 'GET', path: '/analytics/campaigns', params: [] as const, query: [] as const } as Op<{  }>,
  /** Ranking de recorridos por NGR incremental · alcance analytics:read */
  getAnalyticsJourneyImpact: { method: 'GET', path: '/analytics/journey-impact', params: [] as const, query: ['window', 'format'] as const } as Op<{  }>,
  /** Calidad de fuentes de adquisición · alcance analytics:read */
  getAnalyticsSources: { method: 'GET', path: '/analytics/sources', params: [] as const, query: ['days', 'format'] as const } as Op<{  }>,
  /** Entregas por canal y bandeja · alcance analytics:read */
  getChannelsStatus: { method: 'GET', path: '/channels/status', params: [] as const, query: [] as const } as Op<{  }>,
  /** Adquisición y finanzas por campaña · alcance analytics:read */
  getPerformance: { method: 'GET', path: '/performance', params: [] as const, query: ['days', 'brand'] as const } as Op<{  }>,
  /** Payback por cohorte · alcance analytics:read */
  getPerformancePayback: { method: 'GET', path: '/performance/payback', params: [] as const, query: ['weeks', 'brand'] as const } as Op<{  }>,
  /** Alertas de KPI · alcance analytics:read */
  getKpiAlerts: { method: 'GET', path: '/kpi-alerts', params: [] as const, query: [] as const } as Op<{  }>,
  /** Reconocer una alerta */
  postKpiAlertsAlertIdAck: { method: 'POST', path: '/kpi-alerts/{alert_id}/ack', params: ['alert_id'] as const, query: [] as const } as Op<{ alert_id: string }>,
  /** Configurar umbrales de alertas */
  putKpiAlertsConfig: { method: 'PUT', path: '/kpi-alerts/config', params: [] as const, query: [] as const } as Op<{  }>,
  /** Catálogo, presupuestos y otorgamientos recientes · alcance journeys:read */
  getRewards: { method: 'GET', path: '/rewards', params: [] as const, query: [] as const } as Op<{  }>,
  /** Conciliar con el servicio de bonos */
  postRewardsReconcile: { method: 'POST', path: '/rewards/reconcile', params: [] as const, query: [] as const } as Op<{  }>,
  /** Misiones y estadísticas · alcance journeys:read */
  getGamificationMissions: { method: 'GET', path: '/gamification/missions', params: [] as const, query: [] as const } as Op<{  }>,
  /** Guardar misión */
  postGamificationMissions: { method: 'POST', path: '/gamification/missions', params: [] as const, query: [] as const } as Op<{  }>,
  /** Activar o pausar misión */
  postGamificationMissionsMissionIdAction: { method: 'POST', path: '/gamification/missions/{mission_id}/{action}', params: ['mission_id', 'action'] as const, query: [] as const } as Op<{ mission_id: string; action: 'activate' | 'pause' }>,
  /** Torneos y clasificaciones · alcance journeys:read */
  getGamificationTournaments: { method: 'GET', path: '/gamification/tournaments', params: [] as const, query: [] as const } as Op<{  }>,
  /** Guardar torneo */
  postGamificationTournaments: { method: 'POST', path: '/gamification/tournaments', params: [] as const, query: [] as const } as Op<{  }>,
  /** Activar o cerrar torneo */
  postGamificationTournamentsTournamentIdAction: { method: 'POST', path: '/gamification/tournaments/{tournament_id}/{action}', params: ['tournament_id', 'action'] as const, query: [] as const } as Op<{ tournament_id: string; action: 'activate' | 'finalize' }>,
  /** Mini-juegos · alcance journeys:read */
  getGamificationMinigames: { method: 'GET', path: '/gamification/minigames', params: [] as const, query: [] as const } as Op<{  }>,
  /** Verificar resultados con la semilla revelada · alcance journeys:read */
  getGamificationMinigamesGameIdVerify: { method: 'GET', path: '/gamification/minigames/{game_id}/verify', params: ['game_id'] as const, query: ['seed', 'player_id', 'nonce'] as const } as Op<{ game_id: string }>,
  /** Girar (jugador) o rotar semilla (admin) · alcance players:write */
  postGamificationMinigamesGameIdAction: { method: 'POST', path: '/gamification/minigames/{game_id}/{action}', params: ['game_id', 'action'] as const, query: [] as const } as Op<{ game_id: string; action: 'spin' | 'rotate-seed' }>,
  /** Tienda y predicciones · alcance journeys:read */
  getGamificationStore: { method: 'GET', path: '/gamification/store', params: [] as const, query: [] as const } as Op<{  }>,
  /** Guardar artículo de la tienda */
  postGamificationStoreItems: { method: 'POST', path: '/gamification/store/items', params: [] as const, query: [] as const } as Op<{  }>,
  /** Canjear (idempotente por request_id) · alcance players:write */
  postGamificationStoreRedeem: { method: 'POST', path: '/gamification/store/redeem', params: [] as const, query: [] as const } as Op<{  }>,
  /** Guardar predicción */
  postGamificationPredictions: { method: 'POST', path: '/gamification/predictions', params: [] as const, query: [] as const } as Op<{  }>,
  /** Elegir (jugador) o resolver (aprobador) · alcance players:write */
  postGamificationPredictionsPredictionIdAction: { method: 'POST', path: '/gamification/predictions/{prediction_id}/{action}', params: ['prediction_id', 'action'] as const, query: [] as const } as Op<{ prediction_id: string; action: 'pick' | 'resolve' }>,
  /** Abuso de bonos · alcance abuse:read */
  getRiskBonusAbuse: { method: 'GET', path: '/risk/bonus-abuse', params: [] as const, query: [] as const } as Op<{  }>,
  /** Revisión humana de abuso */
  postRiskBonusAbusePlayerIdReview: { method: 'POST', path: '/risk/bonus-abuse/{player_id}/review', params: ['player_id'] as const, query: [] as const } as Op<{ player_id: string }>,
  /** Cola de juego responsable · alcance rg:read */
  getRiskRgMonitor: { method: 'GET', path: '/risk/rg-monitor', params: [] as const, query: [] as const } as Op<{  }>,
  /** Tomar o cerrar un caso */
  postRiskRgCasesCaseIdAction: { method: 'POST', path: '/risk/rg-cases/{case_id}/{action}', params: ['case_id', 'action'] as const, query: [] as const } as Op<{ case_id: string; action: 'take' | 'close' }>,
  /** Borradores de plantillas */
  getContentDrafts: { method: 'GET', path: '/content/drafts', params: [] as const, query: [] as const } as Op<{  }>,
  /** Pedir borrador (IA o texto base) */
  postContentDrafts: { method: 'POST', path: '/content/drafts', params: [] as const, query: [] as const } as Op<{  }>,
  /** Moderar textos sin guardar */
  postContentModerate: { method: 'POST', path: '/content/moderate', params: [] as const, query: [] as const } as Op<{  }>,
  /** Editar, enviar, aprobar o rechazar */
  postContentDraftsDraftIdAction: { method: 'POST', path: '/content/drafts/{draft_id}/{action}', params: ['draft_id', 'action'] as const, query: [] as const } as Op<{ draft_id: string; action: 'edit' | 'submit' | 'approve' | 'reject' }>,
  /** Campañas en el sitio y métricas · alcance analytics:read */
  getOnsiteCampaigns: { method: 'GET', path: '/onsite/campaigns', params: [] as const, query: [] as const } as Op<{  }>,
  /** Guardar campaña */
  postOnsiteCampaigns: { method: 'POST', path: '/onsite/campaigns', params: [] as const, query: [] as const } as Op<{  }>,
  /** Ciclo de aprobación */
  postOnsiteCampaignsCampaignIdAction: { method: 'POST', path: '/onsite/campaigns/{campaign_id}/{action}', params: ['campaign_id', 'action'] as const, query: [] as const } as Op<{ campaign_id: string; action: 'submit' | 'approve' | 'pause' | 'resume' }>,
  /** Contenido a mostrar al jugador en una ubicación · alcance onsite:serve */
  getOnsiteServePlayerId: { method: 'GET', path: '/onsite/serve/{player_id}', params: ['player_id'] as const, query: ['placement', 'request_id', 'locale'] as const } as Op<{ player_id: string }>,
  /** Registrar clic o descarte · alcance onsite:serve */
  postOnsiteEventsPlayerId: { method: 'POST', path: '/onsite/events/{player_id}', params: ['player_id'] as const, query: [] as const } as Op<{ player_id: string }>,
  /** Políticas vigentes, historial y propuestas · alcance policies:read */
  getPolicies: { method: 'GET', path: '/policies', params: [] as const, query: [] as const } as Op<{  }>,
  /** Proponer cambios */
  postPoliciesProposals: { method: 'POST', path: '/policies/proposals', params: [] as const, query: [] as const } as Op<{  }>,
  /** Aprobar o rechazar */
  postPoliciesProposalsProposalIdAction: { method: 'POST', path: '/policies/proposals/{proposal_id}/{action}', params: ['proposal_id', 'action'] as const, query: [] as const } as Op<{ proposal_id: string; action: 'approve' | 'reject' }>,
  /** Tema del admin (colores y logo) */
  getIntegrationSs1Theme: { method: 'GET', path: '/integration/ss1/theme', params: [] as const, query: [] as const } as Op<{  }>,
  /** Catálogo de disparadores del admin */
  getIntegrationSs1TriggerCatalog: { method: 'GET', path: '/integration/ss1/trigger-catalog', params: [] as const, query: [] as const } as Op<{  }>,
  /** Sincronizar datos desde el admin */
  postIntegrationSs1Sync: { method: 'POST', path: '/integration/ss1/sync', params: [] as const, query: [] as const } as Op<{  }>,
  /** Llaves de servicio (sin secretos) */
  getIntegrationServiceKeys: { method: 'GET', path: '/integration/service-keys', params: [] as const, query: [] as const } as Op<{  }>,
  /** Crear llave de servicio (el secreto se muestra una vez) */
  postIntegrationServiceKeys: { method: 'POST', path: '/integration/service-keys', params: [] as const, query: [] as const } as Op<{  }>,
  /** Revocar llave de servicio */
  postIntegrationServiceKeysKeyIdRevoke: { method: 'POST', path: '/integration/service-keys/{key_id}/revoke', params: ['key_id'] as const, query: [] as const } as Op<{ key_id: string }>,
  /** Esta especificación */
  getOpenapiJson: { method: 'GET', path: '/openapi.json', params: [] as const, query: [] as const } as Op<{  }>,
  /** Webhooks salientes · alcance webhooks:manage */
  getWebhooks: { method: 'GET', path: '/webhooks', params: [] as const, query: [] as const } as Op<{  }>,
  /** Crear suscripción · alcance webhooks:manage */
  postWebhooks: { method: 'POST', path: '/webhooks', params: [] as const, query: [] as const } as Op<{  }>,
  /** Pausar, reactivar o rotar secreto · alcance webhooks:manage */
  postWebhooksSubscriptionIdAction: { method: 'POST', path: '/webhooks/{subscription_id}/{action}', params: ['subscription_id', 'action'] as const, query: [] as const } as Op<{ subscription_id: string; action: 'pause' | 'resume' | 'rotate' }>,
  /** Reintentar entrega · alcance webhooks:manage */
  postWebhooksDeliveriesDeliveryIdRetry: { method: 'POST', path: '/webhooks/deliveries/{delivery_id}/retry', params: ['delivery_id'] as const, query: [] as const } as Op<{ delivery_id: string }>,
  /** Enviar entregas pendientes · alcance webhooks:manage */
  postWebhooksDispatch: { method: 'POST', path: '/webhooks/dispatch', params: [] as const, query: [] as const } as Op<{  }>,
  /** Herramientas disponibles para el rol */
  getCopilotTools: { method: 'GET', path: '/copilot/tools', params: [] as const, query: [] as const } as Op<{  }>,
  /** Ejecutar herramienta */
  postCopilotToolsTool: { method: 'POST', path: '/copilot/tools/{tool}', params: ['tool'] as const, query: [] as const } as Op<{ tool: string }>,
  /** Pregunta en lenguaje natural (Claude) */
  postCopilotAsk: { method: 'POST', path: '/copilot/ask', params: [] as const, query: [] as const } as Op<{  }>,
  /** Registro de auditoría encadenado · alcance audit:read */
  getAudit: { method: 'GET', path: '/audit', params: [] as const, query: [] as const } as Op<{  }>,
} as const;

export type CrmOperation = keyof typeof CRM_ENDPOINTS;
export type ParamsOf<K extends CrmOperation> = (typeof CRM_ENDPOINTS)[K] extends Op<infer P> ? P : never;

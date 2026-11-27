-- Gamificación ampliada: retos (por versión), inscripciones, estado de logros por jugador, enlaces
-- compartidos y contadores de tarjetas. Reutiliza gamification_definitions y gamification_progress
-- (001_init.sql); solo amplía los tipos admitidos y agrega índices para leer por tipo y por cambio.

ALTER TABLE gamification_definitions DROP CONSTRAINT IF EXISTS gamification_definitions_kind_check;
ALTER TABLE gamification_definitions ADD CONSTRAINT gamification_definitions_kind_check
  CHECK (kind IN ('mission','tournament','minigame','prediction','challenge'));

-- gamification_progress.kind: 'challenge' (inscripción), 'achievements' (estado del jugador),
-- 'share_link' (id = enlace opaco) y 'share_metrics' (id = logro, player_id = '-')
ALTER TABLE gamification_progress DROP CONSTRAINT IF EXISTS gamification_progress_kind_check;
ALTER TABLE gamification_progress ADD CONSTRAINT gamification_progress_kind_check
  CHECK (kind IN ('mission','tournament','minigame','prediction','challenge','achievements','share_link','share_metrics'));

CREATE INDEX IF NOT EXISTS gamification_definitions_kind ON gamification_definitions (tenant_id, kind, updated_at);
CREATE INDEX IF NOT EXISTS gamification_progress_kind ON gamification_progress (tenant_id, kind, updated_at);
-- un enlace público se busca por su id opaco sin conocer el tenant (vista pública)
CREATE UNIQUE INDEX IF NOT EXISTS gamification_share_link_id ON gamification_progress (id) WHERE kind = 'share_link';

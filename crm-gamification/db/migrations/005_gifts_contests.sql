-- Regalos instantáneos, torneos ampliados, clasificaciones y concursos: amplía los tipos de
-- gamification_definitions y gamification_progress (sin tablas nuevas; RLS heredada de 001_init.sql).
--   definiciones: 'gift' (campaña), 'contest' (concurso con bases)
--   progreso:     'gift' (asignación por jugador), 'tournament_entry' (inscripción y puntaje),
--                 'contest_entry' (participación), 'tournament_result' / 'contest_result' (id, player_id = '-')
ALTER TABLE gamification_definitions DROP CONSTRAINT IF EXISTS gamification_definitions_kind_check;
ALTER TABLE gamification_definitions ADD CONSTRAINT gamification_definitions_kind_check
  CHECK (kind IN ('mission','tournament','minigame','prediction','challenge','gift','contest'));

ALTER TABLE gamification_progress DROP CONSTRAINT IF EXISTS gamification_progress_kind_check;
ALTER TABLE gamification_progress ADD CONSTRAINT gamification_progress_kind_check
  CHECK (kind IN ('mission','tournament','minigame','prediction','challenge','achievements','share_link','share_metrics',
                  'gift','tournament_entry','contest_entry','tournament_result','contest_result'));

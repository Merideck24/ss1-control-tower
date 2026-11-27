-- Preferencia del jugador de ocultarse en las clasificaciones (sigue contando; aparece como «Jugador oculto").
--   gamification_progress: kind 'leaderboard_pref', id = 'visibility', player_id = jugador
ALTER TABLE gamification_progress DROP CONSTRAINT IF EXISTS gamification_progress_kind_check;
ALTER TABLE gamification_progress ADD CONSTRAINT gamification_progress_kind_check
  CHECK (kind IN ('mission','tournament','minigame','prediction','challenge','achievements','share_link','share_metrics',
                  'gift','tournament_entry','contest_entry','tournament_result','contest_result','leaderboard_pref'));

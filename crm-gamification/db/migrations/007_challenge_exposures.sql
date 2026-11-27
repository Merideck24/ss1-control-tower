-- Exposiciones a retos con grupo de control (tratamiento o control, estable por jugador y reto), para
-- medir la retención D7/D30 y el incremento contra el control.
--   gamification_progress: kind 'challenge_exposure', id = reto, player_id = jugador
ALTER TABLE gamification_progress DROP CONSTRAINT IF EXISTS gamification_progress_kind_check;
ALTER TABLE gamification_progress ADD CONSTRAINT gamification_progress_kind_check
  CHECK (kind IN ('mission','tournament','minigame','prediction','challenge','achievements','share_link','share_metrics',
                  'gift','tournament_entry','contest_entry','tournament_result','contest_result','leaderboard_pref','challenge_exposure'));

-- Game limits: caps on how many games a team's starters play in one matchup
-- week (src/lib/lineup/gameLimits.ts). Off by default.
--
-- Shape: NULL = no limits, else {"total": 40, "slots": {"C": 8, ...}}: a total
-- for all starting slots together and optional per-slot caps (a slot's spots
-- share one cap; a slot left out has only the total).
--
-- leagues.game_limits is the commissioner's setting. Each week carries its own
-- copy in league_weeks.game_limits, which is what scoring reads: saving the
-- settings copies them onto the weeks that haven't started, so a change applies
-- from the next matchup week and the current one keeps its limits.
-- Idempotent, so it can be applied to a shared dev database by hand.
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS game_limits jsonb;
ALTER TABLE league_weeks ADD COLUMN IF NOT EXISTS game_limits jsonb;

ALTER TABLE leagues DROP CONSTRAINT IF EXISTS leagues_game_limits_check;
ALTER TABLE leagues ADD CONSTRAINT leagues_game_limits_check
  CHECK (game_limits IS NULL OR jsonb_typeof(game_limits -> 'total') = 'number');
ALTER TABLE league_weeks DROP CONSTRAINT IF EXISTS league_weeks_game_limits_check;
ALTER TABLE league_weeks ADD CONSTRAINT league_weeks_game_limits_check
  CHECK (game_limits IS NULL OR jsonb_typeof(game_limits -> 'total') = 'number');

-- A player's NBA team on a given date, for finding "his game that day" when
-- he's been traded. players.team_id is only his current team; each stat line
-- records the team he played for. So: the team of his first stat line on or
-- after `day` (the team he was on then, or joined next), else his current team
-- (today and later, or no games since). Used by the lineup/matchup day views,
-- the week's games count and box scores (src/lib/queries/lineup.ts,
-- matchups.ts, boxScores.ts). Scoring doesn't need it: it reads stat lines.
-- Callers wrap it as LATERAL (SELECT player_team_on(..) AS team_id OFFSET 0),
-- or the planner inlines the call into every game it's compared against.
-- Idempotent, so it can be applied to a shared dev database by hand.
CREATE OR REPLACE FUNCTION player_team_on(player integer, day date) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    -- OFFSET 0 keeps the planner on his few hundred stat lines; without it it
    -- walks every game after `day` by date.
    (SELECT x.team_id
       FROM (SELECT s.team_id, g.date, g.datetime
               FROM player_game_stats s JOIN games g ON g.id = s.game_id
              WHERE s.player_id = player AND s.team_id IS NOT NULL
             OFFSET 0) x
      WHERE x.date >= day
      ORDER BY x.date, x.datetime
      LIMIT 1),
    (SELECT p.team_id FROM players p WHERE p.id = player))
$$;

-- Covering indexes so the lookup above reads no table rows (both tables carry
-- the provider's raw jsonb, so heap reads made it ~10 ms a call).
CREATE INDEX IF NOT EXISTS pgs_player_team_idx ON player_game_stats (player_id) INCLUDE (game_id, team_id);
CREATE INDEX IF NOT EXISTS games_id_date_idx ON games (id) INCLUDE (date, datetime);

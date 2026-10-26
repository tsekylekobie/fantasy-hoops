-- Playoffs and a toilet bowl (src/lib/playoffs/).
--
-- After the regular season (the weeks before leagues.playoff_start_week) the
-- top playoff_teams teams play a single-elimination bracket where the winner
-- advances, and, when toilet_bowl is on, the bottom toilet_bowl_teams teams
-- play one where the LOSER advances; the loser of its final is last place.
-- Teams in neither bracket are done for the season.
--
-- Bracket matchups are ordinary matchups rows (scored the same way as the
-- regular season) tagged with their bracket, round and slot, and the seeds of
-- both sides so later rounds and tiebreaks never depend on standings that
-- moved after the regular season. Round 1 is created when the regular season
-- ends; each later round when the previous round's week ends
-- (syncPlayoffs in src/lib/queries/playoffs.ts, the worker's playoffs task).
-- Idempotent, so it can be applied to a shared dev database by hand.
ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS toilet_bowl boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS toilet_bowl_teams integer NOT NULL DEFAULT 4
    CHECK (toilet_bowl_teams BETWEEN 2 AND 8);

ALTER TABLE matchups
  -- NULL = regular season.
  ADD COLUMN IF NOT EXISTS bracket text CHECK (bracket IN ('playoffs', 'toilet_bowl')),
  -- 1 = the bracket's first round.
  ADD COLUMN IF NOT EXISTS bracket_round integer,
  -- Position in the round, top to bottom from 0. Slots 2k and 2k+1 feed slot k
  -- of the next round (team_a from 2k, team_b from 2k+1).
  ADD COLUMN IF NOT EXISTS bracket_slot integer,
  -- Final regular-season seeds (1 = first place) of team_a and team_b.
  ADD COLUMN IF NOT EXISTS seed_a integer,
  ADD COLUMN IF NOT EXISTS seed_b integer;

DO $$ BEGIN
  ALTER TABLE matchups ADD CONSTRAINT matchups_bracket_check CHECK (
    (bracket IS NULL AND bracket_round IS NULL AND bracket_slot IS NULL AND seed_a IS NULL AND seed_b IS NULL)
    OR (bracket IS NOT NULL AND bracket_round >= 1 AND bracket_slot >= 0 AND seed_a IS NOT NULL
        AND (team_b_id IS NULL) = (seed_b IS NULL)));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- One matchup per bracket position; what makes creating a round idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS matchups_bracket_slot_key
  ON matchups (league_id, bracket, bracket_round, bracket_slot) WHERE bracket IS NOT NULL;

-- This league: an 8-team playoff and a 4-team toilet bowl (8 + 4 = all 12).
UPDATE leagues SET playoff_teams = 8, toilet_bowl = true, toilet_bowl_teams = 4
 WHERE season = 2026;

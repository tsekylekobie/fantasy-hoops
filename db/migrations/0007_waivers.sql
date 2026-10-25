-- Waivers: when the daily run happens, and a record of each run.
-- The settings were added in 0004 (leagues.waiver_type, waiver_time,
-- time_zone, waiver_days, waivers_after_game_start; fantasy_teams.waiver_priority),
-- and so were the tables claims use (transactions type 'waiver_claim' with
-- process_at and claim_rank; waiver_players). Idempotent, so it can be applied
-- to a shared dev database by hand before it's merged.

-- The first waiver run strictly after `after`: the league's waiver_time, in its
-- time zone, on that local day or the next (DST-safe; runs at local time).
CREATE OR REPLACE FUNCTION next_waiver_run(league bigint, after timestamptz) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN x.today > after THEN x.today
              ELSE ((((after AT TIME ZONE l.time_zone)::date + 1) + l.waiver_time) AT TIME ZONE l.time_zone) END
    FROM leagues l,
         LATERAL (SELECT (((after AT TIME ZONE l.time_zone)::date + l.waiver_time) AT TIME ZONE l.time_zone) AS today) x
   WHERE l.id = league
$$;

-- The latest waiver run at or before `at`.
CREATE OR REPLACE FUNCTION last_waiver_run(league bigint, at timestamptz) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN x.today <= at THEN x.today
              ELSE ((((at AT TIME ZONE l.time_zone)::date - 1) + l.waiver_time) AT TIME ZONE l.time_zone) END
    FROM leagues l,
         LATERAL (SELECT (((at AT TIME ZONE l.time_zone)::date + l.waiver_time) AT TIME ZONE l.time_zone) AS today) x
   WHERE l.id = league
$$;

-- One row per waiver run. A scheduled run stands for one daily run time
-- (run_at) and happens once (the unique index); a manual run (scripts/waivers.ts,
-- POST /api/dev/waivers) processes as of `as_of` and doesn't use up a scheduled run.
CREATE TABLE IF NOT EXISTS waiver_runs (
  id          bigserial PRIMARY KEY,
  league_id   bigint NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  scheduled   boolean NOT NULL,
  run_at      timestamptz NOT NULL,          -- the daily run time (scheduled) or when it ran (manual)
  as_of       timestamptz NOT NULL,          -- claims due and waivers cleared by this time were processed
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  claims      integer NOT NULL DEFAULT 0,    -- claims looked at
  won         integer NOT NULL DEFAULT 0,
  failed      integer NOT NULL DEFAULT 0,
  cleared     integer NOT NULL DEFAULT 0     -- players whose waivers ended
);
CREATE UNIQUE INDEX IF NOT EXISTS waiver_runs_scheduled_idx ON waiver_runs (league_id, run_at) WHERE scheduled;

-- A team's pending claims in its own preference order (claim_rank, 1 = first).
CREATE INDEX IF NOT EXISTS transactions_pending_claims_idx ON transactions (team_id, claim_rank)
  WHERE type = 'waiver_claim' AND status = 'pending';

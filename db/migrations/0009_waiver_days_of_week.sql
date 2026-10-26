-- Waivers on chosen days of the week. 0007's run was every day at
-- leagues.waiver_time; this adds the days it happens (ISO weekdays in the
-- league's time zone: 1 = Monday ... 7 = Sunday, default all seven) and
-- redefines next_waiver_run / last_waiver_run to skip the other days.
-- Everything that schedules a run goes through those two functions: drops'
-- waiver_players.clears_at, claims' process_at, the worker's processDueWaivers.
-- Changed from the League settings page (src/lib/queries/settings.ts).
-- Idempotent, so it can be applied to a shared dev database by hand.
ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS waiver_days_of_week integer[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}'
    CHECK (cardinality(waiver_days_of_week) > 0 AND waiver_days_of_week <@ '{1,2,3,4,5,6,7}');

-- The first waiver run strictly after `after`: waiver_time on the next chosen
-- weekday, in the league's time zone (DST-safe; runs at local time). A week
-- and a day of candidates covers "today, but the time has passed".
CREATE OR REPLACE FUNCTION next_waiver_run(league bigint, after timestamptz) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT min(x.t)
    FROM leagues l,
         LATERAL generate_series(0, 7) AS d(n),
         LATERAL (SELECT (after AT TIME ZONE l.time_zone)::date + d.n AS day) dd,
         LATERAL (SELECT ((dd.day + l.waiver_time) AT TIME ZONE l.time_zone) AS t) x
   WHERE l.id = league
     AND extract(isodow FROM dd.day)::int = ANY (l.waiver_days_of_week)
     AND x.t > after
$$;

-- The latest waiver run at or before `at`.
CREATE OR REPLACE FUNCTION last_waiver_run(league bigint, at timestamptz) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT max(x.t)
    FROM leagues l,
         LATERAL generate_series(0, 7) AS d(n),
         LATERAL (SELECT (at AT TIME ZONE l.time_zone)::date - d.n AS day) dd,
         LATERAL (SELECT ((dd.day + l.waiver_time) AT TIME ZONE l.time_zone) AS t) x
   WHERE l.id = league
     AND extract(isodow FROM dd.day)::int = ANY (l.waiver_days_of_week)
     AND x.t <= at
$$;

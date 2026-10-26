-- IL eligibility goes off the player's current injury status only: he may move
-- into IL or IL+ whenever his latest status is one of il_statuses /
-- il_plus_statuses. The minimum time on the injury report (0008) is gone.
-- The rule is evaluated in one place: ilEligibility in src/lib/lineup/rules.ts.
ALTER TABLE leagues
  DROP COLUMN IF EXISTS il_min_days,
  DROP COLUMN IF EXISTS il_plus_min_days;

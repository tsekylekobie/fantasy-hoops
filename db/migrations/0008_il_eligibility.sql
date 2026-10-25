-- IL eligibility rule, part two. 0004 already has the statuses that may use
-- each IL slot (il_statuses, il_plus_statuses); these add a minimum time on
-- the injury report: days since the player was first listed with a
-- qualifying status, without a break, counted to the lineup's date.
-- 0 = eligible the day he's listed. The rule is evaluated in one place:
-- ilEligibility in src/lib/lineup/rules.ts.
--
-- A player who stops qualifying stays in his IL slot, but his team's roster
-- is illegal (no adds or waiver claims) until he's moved or dropped.
-- Idempotent, so it can be applied by hand before the migrations in front of
-- it are merged.
ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS il_min_days integer NOT NULL DEFAULT 0 CHECK (il_min_days >= 0),
  ADD COLUMN IF NOT EXISTS il_plus_min_days integer NOT NULL DEFAULT 0 CHECK (il_plus_min_days >= 0);

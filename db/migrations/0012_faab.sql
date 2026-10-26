-- FAAB waivers (waiver_type 'faab'; src/lib/queries/waivers.ts).
--
-- 0004 already has leagues.faab_budget, fantasy_teams.faab_balance (NULL
-- unless the league is FAAB) and transactions.faab_bid (a waiver claim's
-- blind bid, whole dollars; on a completed claim, what it cost). This adds the
-- commissioner's minimum bid, keeps the amounts sane, and links each claim to
-- the waiver run that decided it.
-- Idempotent, so it can be applied to a shared dev database by hand.
ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS faab_min_bid integer NOT NULL DEFAULT 0;

ALTER TABLE leagues DROP CONSTRAINT IF EXISTS leagues_faab_amounts_check;
ALTER TABLE leagues ADD CONSTRAINT leagues_faab_amounts_check
  CHECK (faab_budget >= 0 AND faab_min_bid >= 0 AND faab_min_bid <= faab_budget);

ALTER TABLE fantasy_teams DROP CONSTRAINT IF EXISTS fantasy_teams_faab_balance_check;
ALTER TABLE fantasy_teams ADD CONSTRAINT fantasy_teams_faab_balance_check CHECK (faab_balance >= 0);

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_faab_bid_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_faab_bid_check CHECK (faab_bid >= 0);

-- The waiver run that decided a claim (won or failed), for the League page's
-- waiver run summaries. NULL for claims cancelled or decided before this.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS waiver_run_id bigint REFERENCES waiver_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS transactions_waiver_run_idx ON transactions (waiver_run_id) WHERE waiver_run_id IS NOT NULL;

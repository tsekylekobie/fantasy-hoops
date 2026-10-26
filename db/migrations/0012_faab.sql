-- FAAB waivers (waiver_type 'faab'; src/lib/queries/waivers.ts).
--
-- 0004 already has leagues.faab_budget, fantasy_teams.faab_balance (NULL
-- unless the league is FAAB) and transactions.faab_bid (a waiver claim's
-- blind bid, whole dollars; on a completed claim, what it cost). This adds the
-- commissioner's minimum bid and keeps the amounts sane.
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

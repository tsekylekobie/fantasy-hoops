-- Waiver claims and IL status changes (commissioner setting, on by default).
-- When on, the waiver run doesn't fail a claim because a player on the team's
-- IL or IL+ no longer qualifies for that slot (his injury status changed after
-- the claim was placed). Everything else is still checked, and the roster is
-- still illegal afterwards, so the manager has to fix it before the next add.
-- Read by checkMove in src/lib/queries/transactions.ts.
-- Idempotent, so it can be applied to a shared dev database by hand.
ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS claims_ignore_il_status boolean NOT NULL DEFAULT true;

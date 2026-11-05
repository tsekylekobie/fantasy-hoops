-- All adds by claim (commissioner setting, off by default). When on, every add
-- waits for the next waiver run as a claim, including free agents who aren't on
-- waivers; otherwise those are added right away. Drops with no add stay
-- immediate. Read by waiverReason in src/lib/transactions/policy.ts.
-- Idempotent, so it can be applied to a shared dev database by hand.
ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS all_adds_by_claim boolean NOT NULL DEFAULT false;

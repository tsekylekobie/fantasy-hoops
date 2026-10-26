-- Punt weights: each user's per-category multipliers for 9CAT value on the
-- players page ({"fgPct": 1, ..., "tov": 0.25}, keys = CATEGORIES in
-- src/lib/types.ts). Null = never saved: the defaults (DEFAULT_WEIGHTS).
-- Validated in TS (src/lib/queries/weights.ts), saved via PUT /api/me/weights.
-- Idempotent, so it can be applied to a shared dev database by hand.
ALTER TABLE users ADD COLUMN IF NOT EXISTS category_weights jsonb;

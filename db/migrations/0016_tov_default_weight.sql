-- The default turnover weight moved from 0.25 to 0.3, onto the punt sliders'
-- tenths (DEFAULT_WEIGHTS in src/lib/types.ts). Saved weights that are exactly
-- the old defaults were never customized (any change saves the whole set,
-- Reset included), so clear them: NULL means "use the defaults". Any other
-- saved set is the user's choice and stays.
-- Idempotent, so it can be applied to a shared dev database by hand.
UPDATE users SET category_weights = NULL
 WHERE category_weights = '{"fgPct": 1, "ftPct": 1, "fg3m": 1, "pts": 1, "reb": 1, "ast": 1, "stl": 1, "blk": 1, "tov": 0.25}'::jsonb;

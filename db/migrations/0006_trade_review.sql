-- Trades (src/lib/queries/trades.ts). The review settings already live on the
-- league (0004: trade_review, trade_review_days, trade_veto_votes,
-- trade_deadline); this makes league voting the default review, since this
-- league reviews trades by vote, and moves existing leagues still on the old
-- default over (there's no settings page yet, so none chose it on purpose).
ALTER TABLE leagues ALTER COLUMN trade_review SET DEFAULT 'league_vote';
UPDATE leagues SET trade_review = 'league_vote' WHERE trade_review = 'commissioner';

-- Pending trades by team, for "your trades" and the per-team pending checks.
CREATE INDEX IF NOT EXISTS transactions_pending_trades_idx
  ON transactions (league_id, team_id, trade_team_id)
  WHERE type = 'trade' AND status = 'pending';

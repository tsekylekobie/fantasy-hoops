-- Watchlist: players a user is keeping an eye on (the star on the Players
-- page and in the player modal). Per user, not per fantasy team or season, so
-- it works before joining the league and carries over. Read and written by
-- src/lib/queries/watchlist.ts; PUT/DELETE /api/players/:id/watch toggles it,
-- and GET /api/players?scope=watch lists it.
-- Idempotent, so it can be applied to a shared dev database by hand.
CREATE TABLE IF NOT EXISTS player_watchlist (
  user_id    bigint  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  player_id  integer NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, player_id)
);

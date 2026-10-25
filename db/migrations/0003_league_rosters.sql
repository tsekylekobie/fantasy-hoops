-- Fantasy league. There is one league per season; ownership is scoped to a
-- league so a new season can start fresh without touching the last one.
-- (The NBA's own teams live in `teams`; ours are `fantasy_teams`.)
CREATE TABLE IF NOT EXISTS leagues (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL,
  season     integer NOT NULL,                -- 2026 = 2026-27
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fantasy_teams (
  id              bigserial PRIMARY KEY,
  league_id       bigint NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  owner_user_id   bigint REFERENCES users(id) ON DELETE SET NULL,  -- null = unclaimed team
  name            text NOT NULL,
  abbreviation    text NOT NULL,              -- 2-4 letters, shown in the nav chip
  waiver_priority integer,                    -- 1 = first claim
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (league_id, id),                     -- target of roster_players' composite FK
  UNIQUE (league_id, abbreviation),
  UNIQUE (league_id, owner_user_id)
);

-- Player ownership: one row per rostered player, and a player is on at most
-- one team per league (the primary key). Free agents have no row.
-- slot is the player's current lineup spot; BN = bench, IL = injured list.
CREATE TABLE IF NOT EXISTS roster_players (
  league_id       bigint NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  player_id       integer NOT NULL REFERENCES players(id),
  fantasy_team_id bigint NOT NULL,
  slot            text NOT NULL DEFAULT 'BN'
                  CHECK (slot IN ('PG','SG','G','SF','PF','F','C','UTIL','BN','IL')),
  acquired_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, player_id),
  FOREIGN KEY (league_id, fantasy_team_id) REFERENCES fantasy_teams (league_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS roster_players_team_idx ON roster_players (fantasy_team_id);

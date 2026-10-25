-- Fantasy Hoops schema. Idempotent: safe to re-run (npm run db:migrate).
-- Column names follow the documented BALLDONTLIE fields; `raw` keeps the full
-- API object until the field names are confirmed against data/samples/.

CREATE TABLE IF NOT EXISTS teams (
  id           integer PRIMARY KEY,          -- BALLDONTLIE team id
  abbreviation text NOT NULL,
  city         text,
  name         text,
  full_name    text,
  conference   text,
  division     text,
  raw          jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS players (
  id            integer PRIMARY KEY,         -- BALLDONTLIE player id
  first_name    text NOT NULL,
  last_name     text NOT NULL,
  position      text,                        -- e.g. "G", "F-C"; may be empty
  team_id       integer REFERENCES teams(id),
  jersey_number text,
  nba_person_id integer,                     -- set by scripts/map-headshots.py
  raw           jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS games (
  id                 integer PRIMARY KEY,    -- BALLDONTLIE game id
  date               date NOT NULL,
  season             integer NOT NULL,       -- 2026 = 2026-27
  status             text,
  period             integer,
  time               text,
  postseason         boolean NOT NULL DEFAULT false,
  home_team_id       integer REFERENCES teams(id),
  visitor_team_id    integer REFERENCES teams(id),
  home_team_score    integer,
  visitor_team_score integer,
  raw                jsonb,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS games_season_idx ON games (season);

CREATE TABLE IF NOT EXISTS player_game_stats (
  id         integer PRIMARY KEY,            -- BALLDONTLIE stat id
  player_id  integer NOT NULL REFERENCES players(id),
  game_id    integer NOT NULL REFERENCES games(id),
  team_id    integer REFERENCES teams(id),
  season     integer NOT NULL,               -- denormalized from games for fast filtering
  min        numeric(5,2),                   -- minutes as a decimal; API sends a string
  fgm integer, fga integer,
  fg3m integer, fg3a integer,
  ftm integer, fta integer,
  oreb integer, dreb integer, reb integer,
  ast integer, stl integer, blk integer,
  turnover integer, pf integer, pts integer,
  raw        jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, game_id)
);
CREATE INDEX IF NOT EXISTS pgs_season_player_idx ON player_game_stats (season, player_id);

-- Additions (data-ingest layer). Columns are only ever added, never renamed.
ALTER TABLE games ADD COLUMN IF NOT EXISTS status_state text;      -- e.g. "final"
ALTER TABLE games ADD COLUMN IF NOT EXISTS datetime timestamptz;   -- tip-off time
ALTER TABLE games ADD COLUMN IF NOT EXISTS postponed boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS games_date_idx ON games (date);

-- Denormalized from games so averages can filter regular season cheaply.
ALTER TABLE player_game_stats ADD COLUMN IF NOT EXISTS postseason boolean NOT NULL DEFAULT false;
ALTER TABLE player_game_stats ADD COLUMN IF NOT EXISTS plus_minus integer;
CREATE INDEX IF NOT EXISTS pgs_player_game_idx ON player_game_stats (player_id, game_id);
CREATE INDEX IF NOT EXISTS pgs_game_idx ON player_game_stats (game_id);

-- Progress bookkeeping for resumable batch jobs (scripts/backfill-stats.ts).
-- key e.g. "stats:season:2025"; cursor = last next_cursor fully stored.
CREATE TABLE IF NOT EXISTS sync_state (
  key          text PRIMARY KEY,
  cursor       bigint,
  completed_at timestamptz,
  rows_written integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The provider flags play-in games and the NBA Cup Championship as
-- postseason = false, but neither counts toward official regular-season stats.
-- game_type: 'regular' | 'cup_final' | 'play_in' | 'playoffs' (set by the backfill).
-- player_game_stats.regular_season mirrors game_type = 'regular'; use it
-- (not NOT postseason) for season averages.
ALTER TABLE games ADD COLUMN IF NOT EXISTS game_type text;
ALTER TABLE player_game_stats ADD COLUMN IF NOT EXISTS regular_season boolean;
CREATE INDEX IF NOT EXISTS pgs_season_regular_idx ON player_game_stats (season, regular_season, player_id);

-- Sign-in (Google OAuth). google_sub is Google's stable account id; mock
-- sign-ins in local dev use 'mock:<email>' so they never collide with real ones.
CREATE TABLE IF NOT EXISTS users (
  id           bigserial PRIMARY KEY,
  google_sub   text NOT NULL UNIQUE,
  email        text NOT NULL,
  name         text NOT NULL,
  picture_url  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- One row per signed-in device. The cookie holds a random token; only its
-- SHA-256 is stored, so a leaked table can't be replayed as cookies.
-- expires_at slides forward while the device keeps using the app.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   bytea PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

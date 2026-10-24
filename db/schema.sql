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

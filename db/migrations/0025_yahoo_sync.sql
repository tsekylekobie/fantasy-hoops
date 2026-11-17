-- The Yahoo Fantasy API as the league's source of truth (src/lib/yahoo/sync.ts).
-- The league keeps playing on Yahoo; the worker's `yahoo` task mirrors it here.
--
-- yahoo_connection: the one OAuth connection to Yahoo (a data connection, not a
-- sign-in), made once by the commissioner at /league/yahoo. Tokens are
-- encrypted with YAHOO_TOKEN_KEY (AES-256-GCM, src/lib/yahoo/crypto.ts). The
-- *_at columns pace the worker (rosters every few minutes, the current week's
-- scoreboard hourly, settings and every week's results daily); `cache` holds the
-- last league settings, teams and weeks so a rosters-only pass can still build
-- a whole snapshot.
CREATE TABLE IF NOT EXISTS yahoo_connection (
  id                   smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  league_key           text,                 -- e.g. "466.l.12345"; NULL until chosen
  connected_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  yahoo_guid           text,                 -- the connecting Yahoo account (xoauth_yahoo_guid)
  redirect_uri         text NOT NULL,        -- as registered; Yahoo wants it again on refresh
  refresh_token_enc    text NOT NULL,
  access_token_enc     text,
  access_expires_at    timestamptz,
  connected_at         timestamptz NOT NULL DEFAULT now(),
  cache                jsonb,
  last_refresh_at      timestamptz,          -- last successful sync of any kind
  last_rosters_at      timestamptz,
  last_scoreboard_at   timestamptz,
  last_full_at         timestamptz,
  last_week            integer,              -- Yahoo's current_week at the last full sync
  last_error           text,
  last_error_at        timestamptz,
  throttled_until      timestamptz,          -- Yahoo said "slow down": no calls before this
  manual_refresh_at    timestamptz           -- POST /api/yahoo/refresh: at most once a minute
);

-- Stable Yahoo keys, so a sync updates rows in place.
ALTER TABLE fantasy_teams
  ADD COLUMN IF NOT EXISTS yahoo_team_key text,        -- "466.l.12345.t.3"
  ADD COLUMN IF NOT EXISTS yahoo_standing jsonb;       -- {rank, wins, losses, ties, pct} as Yahoo has it
CREATE UNIQUE INDEX IF NOT EXISTS fantasy_teams_yahoo_key ON fantasy_teams (league_id, yahoo_team_key)
  WHERE yahoo_team_key IS NOT NULL;

-- Yahoo player key ("466.p.6014") -> our player. Matched by name on first sight;
-- a hand-made row (matched_by = 'hand') is never re-matched.
CREATE TABLE IF NOT EXISTS yahoo_players (
  yahoo_player_key text PRIMARY KEY,
  player_id        integer REFERENCES players(id) ON DELETE SET NULL,
  name             text NOT NULL,
  nba_team         text NOT NULL DEFAULT '',
  matched_by       text NOT NULL DEFAULT 'name' CHECK (matched_by IN ('name', 'hand')),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Yahoo's transaction key ("466.l.12345.tr.87"), or "csv:<fingerprint>" from the
-- CSV import, so transactions are appended once.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS yahoo_key text;
CREATE UNIQUE INDEX IF NOT EXISTS transactions_yahoo_key ON transactions (league_id, yahoo_key)
  WHERE yahoo_key IS NOT NULL;

-- final = false: the current week's live totals from Yahoo's scoreboard. Only
-- final rows replace a computed week (weekLines, the Matchup page); power
-- rankings read every row.
ALTER TABLE week_results ADD COLUMN IF NOT EXISTS final boolean NOT NULL DEFAULT true;

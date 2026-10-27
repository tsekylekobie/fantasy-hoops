-- Importing a league from Yahoo (scripts/yahoo/import.ts).
--
-- league_members: who manages which team, by Google email. The import writes
-- it from the snapshot's members.csv, and sign-in (src/lib/auth/members.ts)
-- links a user to their team, and to the commissioner seat, the first time
-- they sign in with that email. Teams already owned are left alone.
--
-- week_results: a team's category totals for a week as Yahoo scored it. A week
-- with rows here is final: scoring (weekLines and the Matchup page in
-- src/lib/queries/matchups.ts) uses these instead of computing the week from
-- lineups, so imported weeks keep Yahoo's results exactly. Shape: CategoryLine
-- in src/lib/types.ts.
-- Idempotent, so it can be applied to a shared dev database by hand.
ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS yahoo_league_key text,       -- e.g. "466.l.12345"; NULL = not imported
  ADD COLUMN IF NOT EXISTS imported_at timestamptz;

CREATE TABLE IF NOT EXISTS league_members (
  league_id       bigint NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  email           text NOT NULL CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%'),
  fantasy_team_id bigint NOT NULL,
  is_commissioner boolean NOT NULL DEFAULT false,
  PRIMARY KEY (league_id, email),
  FOREIGN KEY (league_id, fantasy_team_id) REFERENCES fantasy_teams (league_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS league_members_email_idx ON league_members (email);

CREATE TABLE IF NOT EXISTS week_results (
  league_id       bigint NOT NULL,
  week            integer NOT NULL,
  fantasy_team_id bigint NOT NULL,
  line            jsonb NOT NULL,
  PRIMARY KEY (league_id, week, fantasy_team_id),
  FOREIGN KEY (league_id, week) REFERENCES league_weeks (league_id, week) ON DELETE CASCADE,
  FOREIGN KEY (league_id, fantasy_team_id) REFERENCES fantasy_teams (league_id, id) ON DELETE CASCADE
);

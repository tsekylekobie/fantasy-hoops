-- Team profiles: managers rename their team, change its abbreviation and
-- upload a logo (src/lib/queries/teamProfile.ts, /api/team/profile).
--
-- Logos live in Postgres, not on disk (the deploy's disk doesn't persist).
-- The image is cropped and downscaled to a small square in the browser before
-- upload; the server checks its real type from the bytes. One row per team.
-- fantasy_teams.logo_updated_at mirrors team_logos.updated_at (null = no
-- logo), so every query that shows a team can build its versioned logo URL
-- (/api/teams/<id>/logo?v=...) without joining the image table.
-- Idempotent, so it can be applied to a shared dev database by hand.
CREATE TABLE IF NOT EXISTS team_logos (
  team_id      bigint PRIMARY KEY REFERENCES fantasy_teams(id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes        bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 1048576),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE fantasy_teams ADD COLUMN IF NOT EXISTS logo_updated_at timestamptz;

-- Team names are unique within a league, ignoring case and surrounding spaces
-- (abbreviations already are: UNIQUE (league_id, abbreviation) in 0003).
CREATE UNIQUE INDEX IF NOT EXISTS fantasy_teams_league_name_key ON fantasy_teams (league_id, lower(btrim(name)));

// Team logos, shared by every query that shows a team. Logos are stored in
// Postgres (team_logos, migration 0010) and served from /api/teams/<id>/logo?v=<version>;
// fantasy_teams.logo_updated_at is the version every team query selects to build `logoUrl`.
// Kept free of other query imports so any query module can use it.
import type { Pool } from "pg";
import type { FantasyTeamSummary, TEAM_LOGO_TYPES } from "../types";

export type TeamLogoType = (typeof TEAM_LOGO_TYPES)[number];

/** The URL for a team's logo, versioned so a new upload busts caches; null without one. */
export function teamLogoUrl(teamId: number, updatedAt: Date | string | null): string | null {
  if (updatedAt === null) return null;
  const v = (updatedAt instanceof Date ? updatedAt : new Date(updatedAt)).getTime();
  return `/api/teams/${teamId}/logo?v=${v}`;
}

/** A team row as queries select it (`ft.id::int, ft.name, ft.abbreviation, ft.logo_updated_at`). */
export interface TeamRow {
  id: number;
  name: string;
  abbreviation: string;
  logo_updated_at: Date | null;
}

export const toTeamSummary = (t: TeamRow): FantasyTeamSummary => ({
  id: t.id, name: t.name, abbreviation: t.abbreviation, logoUrl: teamLogoUrl(t.id, t.logo_updated_at),
});

/** GET /api/teams/<id>/logo. */
export async function getTeamLogo(db: Pool, teamId: number): Promise<{ type: TeamLogoType; bytes: Buffer; updatedAt: Date } | null> {
  const { rows: [r] } = await db.query<{ content_type: TeamLogoType; bytes: Buffer; updated_at: Date }>(
    `SELECT content_type, bytes, updated_at FROM team_logos WHERE team_id = $1`,
    [teamId],
  );
  return r ? { type: r.content_type, bytes: r.bytes, updatedAt: r.updated_at } : null;
}

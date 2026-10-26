// Team logo URLs, shared by every query that shows a team (see teamProfile.ts).
// Kept free of other imports so any query module can use it.
import type { FantasyTeamSummary } from "../types";

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

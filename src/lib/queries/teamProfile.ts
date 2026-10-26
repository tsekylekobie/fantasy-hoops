// Team profiles: a manager renames their team, changes its abbreviation and
// uploads a logo; the commissioner may do the same for any team in the league.
// Logos are stored in Postgres (team_logos, migration 0010) and served from
// /api/teams/<id>/logo?v=<version>; fantasy_teams.logo_updated_at is the
// version every team query selects to build `logoUrl`.
import type { Pool } from "pg";
import {
  TEAM_ABBREVIATION,
  TEAM_LOGO_MAX_BYTES,
  TEAM_LOGO_TYPES,
  TEAM_NAME_LENGTH,
  type FantasyTeamSummary,
  type TeamProfileUpdate,
} from "../types";
import { LineupError } from "./lineup";
import { toTeamSummary, type TeamRow } from "./teamLogo";

export type TeamLogoType = (typeof TEAM_LOGO_TYPES)[number];

/** Validates a TeamProfileUpdate: trims the name, uppercases the abbreviation. */
export function parseProfileUpdate(body: unknown): { update: TeamProfileUpdate } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "Send a JSON object." };
  const b = body as Record<string, unknown>;
  const update: TeamProfileUpdate = {};
  if (b.teamId !== undefined) {
    if (typeof b.teamId !== "number" || !Number.isInteger(b.teamId) || b.teamId <= 0) return { error: "teamId must be a team id." };
    update.teamId = b.teamId;
  }
  if (b.name !== undefined) {
    if (typeof b.name !== "string") return { error: "The name must be text." };
    const name = b.name.trim().replace(/\s+/g, " ");
    if (name.length < TEAM_NAME_LENGTH.min || name.length > TEAM_NAME_LENGTH.max) {
      return { error: `The name must be ${TEAM_NAME_LENGTH.min}–${TEAM_NAME_LENGTH.max} characters.` };
    }
    update.name = name;
  }
  if (b.abbreviation !== undefined) {
    if (typeof b.abbreviation !== "string") return { error: "The abbreviation must be text." };
    const abbreviation = b.abbreviation.trim().toUpperCase();
    if (!TEAM_ABBREVIATION.test(abbreviation)) return { error: "The abbreviation must be 2–4 letters or digits, with at least one letter." };
    update.abbreviation = abbreviation;
  }
  if (update.name === undefined && update.abbreviation === undefined) return { error: "Nothing to change." };
  return { update };
}

/** The image type from the file's first bytes (not its name or declared type); null if it isn't PNG, JPEG or WebP. */
export function sniffImageType(bytes: Uint8Array): TeamLogoType | null {
  const at = (i: number, sig: number[]) => sig.every((b, j) => bytes[i + j] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp"; // RIFF....WEBP
  return null;
}

const TEAM_SELECT = `ft.id::int, ft.name, ft.abbreviation, ft.logo_updated_at`;

/**
 * The team `userId` may edit: `teamId` (default their own) in `season`'s
 * league, if they own it or are the league's commissioner. 404 / 403 otherwise.
 */
async function editableTeam(db: Pool, userId: number, season: number, teamId?: number): Promise<TeamRow & { league_id: number }> {
  const { rows: [t] } = await db.query<TeamRow & { league_id: number; owner_user_id: number | null; commissioner_user_id: number | null }>(
    `SELECT ${TEAM_SELECT}, ft.league_id::int, ft.owner_user_id::int, l.commissioner_user_id::int
       FROM fantasy_teams ft JOIN leagues l ON l.id = ft.league_id
      WHERE l.season = $1 AND ${teamId === undefined ? "ft.owner_user_id = $2" : "ft.id = $2"}
      ORDER BY l.id DESC LIMIT 1`,
    [season, teamId ?? userId],
  );
  if (!t) throw new LineupError(teamId === undefined ? "You don't have a team in this league." : "No such team in this league.", 404);
  if (t.owner_user_id !== userId && t.commissioner_user_id !== userId) {
    throw new LineupError("Only the team's manager (or the commissioner) can edit it.", 403);
  }
  return t;
}

/** PATCH /api/team/profile. */
export async function updateTeamProfile(db: Pool, userId: number, season: number, body: unknown): Promise<FantasyTeamSummary> {
  const parsed = parseProfileUpdate(body);
  if ("error" in parsed) throw new LineupError(parsed.error, 400);
  const { teamId, name, abbreviation } = parsed.update;
  const team = await editableTeam(db, userId, season, teamId);
  try {
    const { rows: [t] } = await db.query<TeamRow>(
      `UPDATE fantasy_teams ft SET name = coalesce($2, name), abbreviation = coalesce($3, abbreviation)
        WHERE id = $1 RETURNING ${TEAM_SELECT}`,
      [team.id, name ?? null, abbreviation ?? null],
    );
    return toTeamSummary(t);
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === "23505") {
      throw new LineupError(
        e.constraint === "fantasy_teams_league_name_key"
          ? `Another team in the league is already called “${name}”.`
          : `Another team in the league already uses ${abbreviation}.`,
        409,
      );
    }
    throw err;
  }
}

/** PUT /api/team/profile/logo: replaces the team's logo with `bytes`. */
export async function setTeamLogo(pool: Pool, userId: number, season: number, teamId: number | undefined, bytes: Uint8Array): Promise<FantasyTeamSummary> {
  if (bytes.length === 0) throw new LineupError("Choose an image to upload.", 400);
  if (bytes.length > TEAM_LOGO_MAX_BYTES) throw new LineupError("The logo must be 1 MB or smaller.", 413);
  const type = sniffImageType(bytes);
  if (!type) throw new LineupError("The logo must be a PNG, JPEG or WebP image.", 415);
  const team = await editableTeam(pool, userId, season, teamId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [{ updated_at }] } = await client.query<{ updated_at: Date }>(
      `INSERT INTO team_logos (team_id, content_type, bytes, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (team_id) DO UPDATE SET content_type = EXCLUDED.content_type, bytes = EXCLUDED.bytes, updated_at = now()
       RETURNING updated_at`,
      [team.id, type, Buffer.from(bytes)],
    );
    await client.query(`UPDATE fantasy_teams SET logo_updated_at = $2 WHERE id = $1`, [team.id, updated_at]);
    await client.query("COMMIT");
    return toTeamSummary({ ...team, logo_updated_at: updated_at });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** DELETE /api/team/profile/logo: the team goes back to its abbreviation badge. */
export async function removeTeamLogo(pool: Pool, userId: number, season: number, teamId: number | undefined): Promise<FantasyTeamSummary> {
  const team = await editableTeam(pool, userId, season, teamId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM team_logos WHERE team_id = $1`, [team.id]);
    await client.query(`UPDATE fantasy_teams SET logo_updated_at = NULL WHERE id = $1`, [team.id]);
    await client.query("COMMIT");
    return toTeamSummary({ ...team, logo_updated_at: null });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** GET /api/teams/<id>/logo. */
export async function getTeamLogo(db: Pool, teamId: number): Promise<{ type: TeamLogoType; bytes: Buffer; updatedAt: Date } | null> {
  const { rows: [r] } = await db.query<{ content_type: TeamLogoType; bytes: Buffer; updated_at: Date }>(
    `SELECT content_type, bytes, updated_at FROM team_logos WHERE team_id = $1`,
    [teamId],
  );
  return r ? { type: r.content_type, bytes: r.bytes, updatedAt: r.updated_at } : null;
}

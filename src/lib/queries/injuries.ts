// Current injury report entries, from player_injuries (the latest row per
// player; a row with status NULL means he left the report).
import type { Pool, PoolClient } from "pg";
import type { PlayerInjury } from "../types";

/**
 * Splits the provider's description into the injury and the news blurb. Two
 * shapes come back: the official report, "Injury/Illness - Right Knee Surgery
 * (2026-10-24, SAS@DAL). Prior reporting (2026-10-24): Aldama (knee) has been
 * ruled out ..." (also "Not With Team (...)", "G League - Two-Way (...)"), and a
 * bare blurb, "Beal (knee) will not be ready ...", where the body part in
 * parentheses is all we get.
 */
export function parseInjuryDescription(description: string | null): { injury: string | null; note: string | null } {
  const text = description?.trim() ?? "";
  if (!text) return { injury: null, note: null };
  const head = /^([^()]+?)\s*\(\d{4}-\d{2}-\d{2}[^)]*\)\.?\s*/.exec(text);
  const note = (head ? text.slice(head[0].length) : text).replace(/^Prior reporting\s*(?:\([^)]*\))?\s*:\s*/, "").trim() || null;
  let injury = head ? head[1].replace(/^Injury\/Illness\s*-\s*/, "").trim() : null;
  if (!injury && note) {
    const part = /^[A-Z][\w.'-]*(?: [A-Z][\w.'-]*)? \(([a-z][a-z /-]*)\)/.exec(note)?.[1];
    if (part) injury = part[0].toUpperCase() + part.slice(1);
  }
  return { injury: injury || null, note };
}

export function toPlayerInjury(status: string | null, returnDate: string | null, description: string | null): PlayerInjury | null {
  // "Available": still listed on the report but cleared to play.
  if (!status || status === "Available") return null;
  return { status, returnDate, ...parseInjuryDescription(description) };
}

/** Current injuries by player id: for `playerIds`, or everyone on the report when omitted. */
export async function getInjuries(db: Pool | PoolClient, playerIds?: number[]): Promise<Map<number, PlayerInjury>> {
  const { rows } = await db.query<{ player_id: number; status: string | null; return_date: string | null; description: string | null }>(
    `SELECT * FROM (
       SELECT DISTINCT ON (player_id) player_id, status, to_char(return_date, 'YYYY-MM-DD') AS return_date, description
         FROM player_injuries
        WHERE $1::int[] IS NULL OR player_id = ANY($1)
        ORDER BY player_id, observed_at DESC, id DESC
     ) latest WHERE status IS NOT NULL`,
    [playerIds ?? null],
  );
  const out = new Map<number, PlayerInjury>();
  for (const r of rows) out.set(r.player_id, toPlayerInjury(r.status, r.return_date, r.description)!);
  return out;
}

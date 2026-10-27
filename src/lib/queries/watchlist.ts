// Each user's watchlist (player_watchlist, migration 0018): the star on the
// Players page and in the player modal, and GET /api/players?scope=watch.
import type { Pool } from "pg";

/** The players the user watches; empty when signed out (null). */
export async function getWatchedIds(db: Pool, userId: number | null, playerIds?: number[]): Promise<Set<number>> {
  if (userId === null) return new Set();
  const { rows } = await db.query<{ player_id: number }>(
    `SELECT player_id FROM player_watchlist
     WHERE user_id = $1 AND ($2::int[] IS NULL OR player_id = ANY($2::int[]))`,
    [userId, playerIds ?? null],
  );
  return new Set(rows.map((r) => r.player_id));
}

/** Watches or unwatches a player; repeating either is a no-op. False when the player doesn't exist. */
export async function setWatched(db: Pool, userId: number, playerId: number, watched: boolean): Promise<boolean> {
  if (!watched) {
    await db.query(`DELETE FROM player_watchlist WHERE user_id = $1 AND player_id = $2`, [userId, playerId]);
    return true;
  }
  const { rowCount } = await db.query(
    `INSERT INTO player_watchlist (user_id, player_id)
     SELECT $1, id FROM players WHERE id = $2
     ON CONFLICT DO NOTHING`,
    [userId, playerId],
  );
  if (rowCount) return true;
  const { rows } = await db.query(`SELECT 1 FROM players WHERE id = $1`, [playerId]);
  return rows.length > 0;
}

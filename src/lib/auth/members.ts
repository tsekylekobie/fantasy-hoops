// League membership by email (league_members, db/migrations/0017_yahoo_import.sql).
// An imported league lists each manager's Google email; signing in with it
// gives the user that team, and the commissioner seat if marked.
import type { Pool, PoolClient } from "pg";

/**
 * Links `userId` to every team listed for `email` that has no owner yet, and
 * makes them commissioner where marked and the seat is empty. Returns teams linked.
 */
export async function linkMemberships(db: Pool | PoolClient, userId: number, email: string): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE fantasy_teams ft SET owner_user_id = $1
       FROM league_members m
      WHERE m.email = lower(btrim($2)) AND ft.id = m.fantasy_team_id AND ft.owner_user_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM fantasy_teams o WHERE o.league_id = ft.league_id AND o.owner_user_id = $1)`,
    [userId, email],
  );
  await db.query(
    `UPDATE leagues l SET commissioner_user_id = $1
       FROM league_members m
      WHERE m.league_id = l.id AND m.email = lower(btrim($2)) AND m.is_commissioner AND l.commissioner_user_id IS NULL`,
    [userId, email],
  );
  return rowCount ?? 0;
}

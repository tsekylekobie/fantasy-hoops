// Sync passes shared by the batch scripts (backfill, sync:players) and the
// long-running worker (scripts/worker.ts). Every pass is an idempotent
// upsert, so any of them can be re-run or interrupted safely.
import type { Pool, PoolClient } from "pg";
import type { DataClient, Injury } from "../../src/lib/bdl";
import { recordInjuries, upsertGames, upsertPlayers, upsertStatLines, upsertTeams } from "./upsert";

type Db = Pool | PoolClient;

export const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

export interface SyncState {
  cursor: number | null;
  completedAt: Date | null;
}

/** Progress for a key in sync_state (batch cursors, and the worker's last-run times). */
export async function getState(db: Db, key: string): Promise<SyncState | null> {
  const { rows } = await db.query(`SELECT cursor, completed_at FROM sync_state WHERE key = $1`, [key]);
  if (!rows.length) return null;
  return { cursor: rows[0].cursor == null ? null : Number(rows[0].cursor), completedAt: rows[0].completed_at };
}

export async function saveState(db: Db, key: string, cursor: number | null, completed: boolean, rowsWritten: number) {
  await db.query(
    `INSERT INTO sync_state (key, cursor, completed_at, rows_written, updated_at)
     VALUES ($1, $2, CASE WHEN $3 THEN now() END, $4, now())
     ON CONFLICT (key) DO UPDATE SET
       cursor = EXCLUDED.cursor,
       completed_at = CASE WHEN $3 THEN now() ELSE sync_state.completed_at END,
       rows_written = sync_state.rows_written + $4,
       updated_at = now()`,
    [key, cursor, completed, rowsWritten],
  );
}

/** A season is "open" if any stored game is neither final nor postponed. */
export async function seasonIsOpen(db: Db, season: number): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM games
     WHERE season = $1 AND NOT postponed AND coalesce(status_state, lower(status)) <> 'final'`,
    [season],
  );
  return rows[0].n > 0;
}

/** The 30 current teams and every player. About 50 requests. */
export async function syncTeamsAndPlayers(db: Db, api: DataClient): Promise<{ teams: number; players: number }> {
  const teams = (await api.teams()).filter((t) => t.isCurrent);
  await upsertTeams(db, teams);
  let players = 0;
  for await (const page of api.players()) players += await upsertPlayers(db, page.items);
  return { teams: teams.length, players };
}

/** Upserts games in a date range (or a whole season). Returns the number upserted. */
export async function syncGames(
  db: Db,
  api: DataClient,
  q: { seasons?: number[]; dates?: string[]; startDate?: string; endDate?: string },
): Promise<number> {
  let n = 0;
  for await (const page of api.games(q)) n += await upsertGames(db, page.items);
  return n;
}

/** Upserts the stat lines for some games or dates, one transaction per page. */
export async function syncStats(
  db: Pool,
  api: DataClient,
  q: { gameIds?: number[]; dates?: string[] },
): Promise<number> {
  if (q.gameIds?.length === 0 || q.dates?.length === 0) return 0;
  let n = 0;
  for await (const page of api.stats(q)) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      n += await upsertStatLines(client, page.items);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  return n;
}

/**
 * Pulls the whole injury report and records what changed. The feed is read
 * in full before anything is written, so a failed page never looks like
 * every player recovering.
 */
export async function syncInjuries(db: Pool, api: DataClient): Promise<{ reported: number; changed: number }> {
  const report: Injury[] = [];
  for await (const page of api.injuries()) report.push(...page.items);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const changed = await recordInjuries(client, report);
    await client.query("COMMIT");
    return { reported: report.length, changed };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

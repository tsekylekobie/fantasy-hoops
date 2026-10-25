// Backfill games and per-player stat lines for whole seasons.
//
// Usage:
//   npm run backfill -- --seasons 2026,2025
//   npm run backfill -- --seasons 2026 --since 2026-10-20   # only games on/after a date
//   npm run backfill -- --seasons 2024 --force               # redo a completed season
//
// Idempotent and resumable:
// - Every page is upserted in one transaction, then the next cursor is saved in
//   sync_state, so an interrupted run resumes where it stopped.
// - A season whose stats finished and whose games are all final is skipped.
// - A season that is still in progress gets an incremental pass from two days
//   before the last completed run (catches stat corrections).
// Postseason games and stats are stored too (postseason = true). Averages
// should filter on player_game_stats.regular_season, which also excludes
// play-in games and the NBA Cup final (the provider marks those
// postseason = false); see classifyGames.
import "dotenv/config";
import { Pool } from "pg";
import { createClient, type DataClient } from "../src/lib/bdl";
import { getState, log, saveState, seasonIsOpen } from "./lib/sync";
import { classifyGames, upsertGames, upsertStatLines } from "./lib/upsert";

interface Args {
  seasons: number[];
  since: string | null;
  force: boolean;
  skipGames: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { seasons: [], since: null, force: false, skipGames: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = a.includes("=") ? a.split("=")[1] : argv[++i];
      if (!v) throw new Error(`Missing value for ${a}`);
      return v;
    };
    if (a.startsWith("--seasons")) args.seasons = val().split(",").map((s) => Number(s.trim()));
    else if (a.startsWith("--since")) args.since = val();
    else if (a === "--force") args.force = true;
    else if (a === "--skip-games") args.skipGames = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.seasons.length || args.seasons.some((s) => !Number.isInteger(s) || s < 1946)) {
    throw new Error("Usage: backfill --seasons 2026,2025 [--since YYYY-MM-DD] [--force] [--skip-games]");
  }
  if (args.since && !/^\d{4}-\d{2}-\d{2}$/.test(args.since)) throw new Error("--since must be YYYY-MM-DD");
  return args;
}

async function backfillGames(db: Pool, api: DataClient, season: number, args: Args) {
  const key = `games:${season}`;
  const state = await getState(db, key);
  if (!args.force && !args.since && state?.completedAt && !(await seasonIsOpen(db, season))) {
    log(`games ${season}: complete, skipping`);
    return;
  }
  let n = 0;
  for await (const page of api.games({ seasons: [season], startDate: args.since ?? undefined })) {
    n += await upsertGames(db, page.items);
  }
  if (!args.since) await saveState(db, key, null, true, n);
  log(`games ${season}: upserted ${n}`);
}

async function backfillStats(db: Pool, api: DataClient, season: number, args: Args) {
  const fullKey = `stats:${season}`;
  const full = await getState(db, fullKey);

  let key = fullKey;
  let startDate: string | undefined;
  let cursor: number | null = null;

  if (args.since) {
    key = `stats:${season}:since:${args.since}`;
    startDate = args.since;
    const s = await getState(db, key);
    cursor = s && !s.completedAt && !args.force ? s.cursor : null;
  } else if (full?.completedAt && !args.force) {
    if (!(await seasonIsOpen(db, season))) {
      log(`stats ${season}: complete, skipping`);
      return;
    }
    // In-progress season: incremental pass from 2 days before the last full run.
    const d = new Date(full.completedAt);
    d.setUTCDate(d.getUTCDate() - 2);
    startDate = d.toISOString().slice(0, 10);
    key = `stats:${season}:incremental`;
    log(`stats ${season}: already backfilled; incremental from ${startDate}`);
  } else {
    cursor = args.force ? null : (full?.cursor ?? null);
    if (args.force) await db.query(`DELETE FROM sync_state WHERE key = $1`, [fullKey]);
    if (cursor) log(`stats ${season}: resuming from cursor ${cursor}`);
  }

  let rows = 0;
  let pages = 0;
  const t0 = Date.now();
  for await (const page of api.stats({ seasons: [season], startDate, cursor })) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const n = await upsertStatLines(client, page.items);
      // Saving the cursor in the same transaction makes resume exact.
      await saveState(client, key, page.nextCursor, page.nextCursor == null, n);
      await client.query("COMMIT");
      rows += n;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    pages++;
    if (pages % 10 === 0 || page.nextCursor == null) {
      const secs = Math.round((Date.now() - t0) / 1000);
      log(`stats ${season}: ${pages} pages, ${rows} rows, ${secs}s, next cursor ${page.nextCursor ?? "done"}`);
    }
  }
  if (key !== fullKey && !args.since) {
    // Incremental pass done: move the full run's completion mark forward.
    await saveState(db, fullKey, null, true, 0);
  }
  log(`stats ${season}: done (${rows} rows in ${pages} pages)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const api = createClient();
  const t0 = Date.now();
  try {
    for (const season of args.seasons) {
      log(`season ${season}`);
      if (!args.skipGames) await backfillGames(db, api, season, args);
      await backfillStats(db, api, season, args);
      const cls = await classifyGames(db, season);
      log(`season ${season}: classified ${cls.playIn} play-in, ${cls.cupFinal} cup-final games (not regular season)`);
      const { rows } = await db.query(
        `SELECT
           (SELECT count(*)::int FROM games WHERE season = $1) AS games,
           (SELECT count(*)::int FROM player_game_stats WHERE season = $1) AS stats,
           (SELECT count(*)::int FROM player_game_stats WHERE season = $1 AND min > 0) AS played,
           (SELECT count(*)::int FROM player_game_stats WHERE season = $1 AND regular_season) AS regular`,
        [season],
      );
      log(`season ${season}: ${rows[0].games} games, ${rows[0].stats} stat rows (${rows[0].played} with minutes, ${rows[0].regular} regular season)`);
    }
    log(`all done: ${api.requestCount} requests in ${Math.round((Date.now() - t0) / 1000)}s`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Imports a Yahoo league from a folder of CSVs built from Yahoo's league pages
// (formats in src/lib/yahoo/csv.ts; the yahoo-csv-refresh skill builds them):
// the fallback for when the Yahoo API connection (npm run yahoo:sync, the
// worker's `yahoo` task) isn't available. A dry run by default: everything runs
// in one transaction that is rolled back, and the report says what would
// change. --apply commits it.
//   npm run yahoo:import -- yahoo-csv/my-league              # dry run
//   npm run yahoo:import -- yahoo-csv/my-league --apply      # update this season's league in place
//   npm run yahoo:import -- yahoo-csv/my-league --apply --replace   # delete it and import over it
//
// The writing is src/lib/yahoo/apply.ts (in place by default: team ids stay,
// teams found by name the first time; --replace deletes the league first).
// What carries over: teams and their managers' emails, the schedule (Yahoo's
// matchup weeks and pairings), every finished week's result exactly as Yahoo
// scored it (week_results), each team's lineup on every day in lineups.csv,
// today's rosters, waiver order, FAAB balances, the settings in league.json and,
// from transactions.csv, completed transactions (league history, adds counted
// against the weekly and season limits, when each rostered player was acquired)
// and the players they left on waivers.
// What doesn't: pending trades and claims, lineups set ahead past this week,
// and playoff brackets.
//
// Also read from the folder:
//   league-settings.json   optional: settings to use instead of league.json's or our defaults, in the
//                          /league/settings shape (LeagueSettings in src/lib/types.ts), e.g.
//                          {"timeZone": "America/Los_Angeles", "gameLimits": {"total": 40, "slots": {}}}
//   player-overrides.csv   Yahoo players matched by hand (yahoo_player_key -> player_id). The import
//                          adds a row with a blank player_id for each player it couldn't match.
//
// Users and their sign-ins are kept: managers who have signed in before are
// linked to their teams right away, everyone else on first sign-in
// (src/lib/auth/members.ts).
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { applySnapshot } from "../../src/lib/yahoo/apply";
import { snapshotFromCsv } from "../../src/lib/yahoo/csv";
import * as Y from "../../src/lib/yahoo/parse";

const dir = process.argv.slice(2).find((a) => !a.startsWith("--"));
const APPLY = process.argv.includes("--apply");
const REPLACE = process.argv.includes("--replace");
const STALE_OK = process.argv.includes("--stale-ok");

const read = (path: string): unknown => JSON.parse(readFileSync(join(dir!, path), "utf8"));
const has = (path: string) => existsSync(join(dir!, path));
const OVERRIDES = "player-overrides.csv";

async function main() {
  if (!dir) throw new Error("Usage: npm run yahoo:import -- <CSV folder> [--apply] [--replace] [--stale-ok]");
  if (!has("league.json")) throw new Error(`${dir} has no league.json (formats in src/lib/yahoo/csv.ts).`);
  const text = (f: string) => (has(f) ? readFileSync(join(dir!, f), "utf8") : "");
  const missing = ["teams.csv", "schedule.csv", "results.csv", "rosters.csv"].filter((f) => !has(f)).map((f) => `${f} is missing.`);
  const csv = snapshotFromCsv({
    league: read("league.json"), teams: text("teams.csv"), schedule: text("schedule.csv"),
    results: text("results.csv"), rosters: text("rosters.csv"), lineups: text("lineups.csv"),
    transactions: text("transactions.csv"),
  });
  const overrides = has(OVERRIDES) ? Y.parseCsv(readFileSync(join(dir, OVERRIDES), "utf8")) : [];
  const kept = overrides.filter((r) => /^\d+$/.test(r.player_id));

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const report = missing.length + csv.errors.length > 0
      ? { notes: [], warnings: [], errors: [...missing, ...csv.errors], unmatched: [] }
      : await applySnapshot(db, csv.snapshot, {
        mode: REPLACE ? "replace" : "upsert",
        source: "csv",
        members: csv.members,
        settingsOverride: has("league-settings.json") ? (read("league-settings.json") as Record<string, unknown>) : undefined,
        playerOverrides: new Map(kept.map((r) => [r.yahoo_player_key, Number(r.player_id)])),
        staleOk: STALE_OK,
      });
    const commit = APPLY && report.errors.length === 0;
    await db.query(commit ? "COMMIT" : "ROLLBACK");

    // Keep the hand-made rows, and list what's still missing for you to fill in.
    if (report.unmatched.length > 0 || has(OVERRIDES)) {
      const header = ["yahoo_player_key", "name", "team", "positions", "where", "player_id"];
      const unmatched = report.unmatched.map((u) => ({ yahoo_player_key: u.key, name: u.name, team: u.team, positions: u.positions, where: u.where, player_id: "" }));
      writeFileSync(join(dir, OVERRIDES), Y.toCsv(header, [...kept, ...unmatched]));
    }

    console.log(`Yahoo import from ${dir} (rosters as of ${csv.snapshot.meta.today})${REPLACE ? ", replacing the league" : ""}\n`);
    for (const n of report.notes) console.log(`  ${n}`);
    if (report.warnings.length > 0) console.log(`\nWarnings (${report.warnings.length}):`);
    for (const w of report.warnings) console.log(`  - ${w}`);
    if (report.errors.length > 0) console.log(`\nErrors (${report.errors.length}), so nothing was saved:`);
    for (const e of report.errors) console.log(`  - ${e}`);
    console.log(commit ? "\nImported." : report.errors.length > 0 ? "" : "\nDry run: nothing was saved. Add --apply to import.");
    if (report.errors.length > 0) process.exitCode = 1;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

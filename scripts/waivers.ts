// Runs waivers by hand, outside the worker's daily schedule:
//   npm run waivers                 # process as of the next scheduled run, now (early)
//   npm run waivers -- --at now     # only claims and waivers already due
//   npm run waivers -- --at 2026-10-28T07:00:00Z
// A manual run doesn't use up the scheduled one; the worker's waivers task
// (scripts/worker.ts) still runs at leagues.waiver_time. Logic: src/lib/queries/waivers.ts.
import "dotenv/config";
import { Pool } from "pg";
import { processWaivers, resolveRunTime } from "../src/lib/queries/waivers";
import { CURRENT_SEASON } from "../src/lib/types";

async function main() {
  const i = process.argv.indexOf("--at");
  const at = i >= 0 ? process.argv[i + 1] ?? "" : "next";
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows: [league] } = await pool.query<{ id: number }>(
      `SELECT id::int FROM leagues WHERE season = $1 ORDER BY id DESC LIMIT 1`,
      [CURRENT_SEASON],
    );
    if (!league) throw new Error(`no league for season ${CURRENT_SEASON}`);
    const asOf = await resolveRunTime(pool, league.id, at);
    if (!asOf) throw new Error(`--at must be next, now, or an ISO time (got "${at}")`);
    const run = (await processWaivers(pool, league.id, asOf, { scheduled: false }))!;
    console.log(`waivers as of ${run.asOf}: ${run.claims} claims, ${run.won} won, ${run.failed} failed, ${run.cleared} cleared`);
    for (const line of run.log) console.log(`  ${line}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

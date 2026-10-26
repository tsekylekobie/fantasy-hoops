// Creates due playoff and toilet bowl rounds by hand, outside the worker:
//   npm run playoffs                        # as of the league's today
//   npm run playoffs -- --today 2027-03-22  # pretend it's that day (testing)
// Idempotent: rounds that exist are left alone. The worker's playoffs task
// (scripts/worker.ts) does the same on its own. Logic: src/lib/queries/playoffs.ts.
import "dotenv/config";
import { Pool } from "pg";
import { syncPlayoffs } from "../src/lib/queries/playoffs";
import { CURRENT_SEASON } from "../src/lib/types";

async function main() {
  const i = process.argv.indexOf("--today");
  const today = i >= 0 ? process.argv[i + 1] ?? "" : undefined;
  if (today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`--today must be yyyy-mm-dd (got "${today}")`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { log, waiting } = await syncPlayoffs(pool, CURRENT_SEASON, { today });
    console.log(waiting ?? (log.length ? log.join("\n") : "nothing due"));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

// Runs one Yahoo sync by hand (src/lib/yahoo/sync.ts), the same pass the
// worker's `yahoo` task runs on its own:
//   npm run yahoo:sync                    # whatever pass is due (rosters, scoreboard or full)
//   npm run yahoo:sync -- --full          # settings, standings, every week, all transactions
//   npm run yahoo:sync -- --scoreboard    # rosters + this week's scoreboard and lineups
//   npm run yahoo:sync -- --dry-run       # fetch and apply, then roll back; prints the report
//   npm run yahoo:sync -- --replace       # delete this season's league and rebuild it from Yahoo
//   npm run yahoo:sync -- --fixtures      # dev only: no Yahoo, serve src/lib/yahoo/fixtures
//                                         # (a made-up 4-team league) with a fake connection
// Needs a connection (/league/yahoo) unless --fixtures.
import "dotenv/config";
import { Pool } from "pg";
import { encryptToken } from "../../src/lib/yahoo/crypto";
import { fixtureFetch } from "../../src/lib/yahoo/fixtureFetch";
import { syncYahoo } from "../../src/lib/yahoo/sync";

const has = (f: string) => process.argv.includes(f);

async function main() {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const fixtures = has("--fixtures") ? fixtureFetch() : null;
    if (fixtures) {
      if (process.env.NODE_ENV === "production") throw new Error("--fixtures is for development databases only.");
      process.env.YAHOO_TOKEN_KEY ||= "fixture-token-key-for-development";
      process.env.YAHOO_CLIENT_ID ||= "fixture";
      process.env.YAHOO_CLIENT_SECRET ||= "fixture";
      await db.query(
        `INSERT INTO yahoo_connection (id, league_key, redirect_uri, refresh_token_enc) VALUES (1, '466.l.12345', 'http://localhost:3000/api/yahoo/callback', $1)
         ON CONFLICT (id) DO UPDATE SET league_key = EXCLUDED.league_key, refresh_token_enc = EXCLUDED.refresh_token_enc, access_token_enc = NULL, throttled_until = NULL`,
        [encryptToken("fixture-refresh")],
      );
    }
    const scope = has("--full") ? "full" : has("--scoreboard") ? "scoreboard" : has("--rosters") ? "rosters" : "auto";
    const r = await syncYahoo(db, {
      scope, replace: has("--replace"), dryRun: has("--dry-run"),
      ...(fixtures && { fetch: fixtures.fetch, minIntervalMs: 0 }),
    });
    console.log(`Yahoo sync: ${r.status} · ${r.summary} · ${r.requests} requests\n`);
    for (const n of r.report?.notes ?? []) console.log(`  ${n}`);
    if (r.report?.warnings.length) console.log(`\nWarnings (${r.report.warnings.length}):`);
    for (const w of r.report?.warnings ?? []) console.log(`  - ${w}`);
    if (r.report?.errors.length) console.log(`\nErrors (${r.report.errors.length}), so nothing was saved:`);
    for (const e of r.report?.errors ?? []) console.log(`  - ${e}`);
    for (const l of r.leagues ?? []) console.log(`  ${l.key}  ${l.name}`);
    if (r.status !== "ok") process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

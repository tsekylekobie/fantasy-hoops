// Upsert the 30 current NBA teams and every player from the provider.
// Usage: npm run sync:players
// Players on defunct franchises or without a team get team_id null.
// nba_person_id is never touched (scripts/map-headshots.py owns it).
// The worker (scripts/worker.ts) runs the same pass twice a day.
import "dotenv/config";
import { Pool } from "pg";
import { createClient } from "../src/lib/bdl";
import { syncTeamsAndPlayers } from "./lib/sync";

async function main() {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const api = createClient();
  const started = Date.now();
  try {
    const { teams, players } = await syncTeamsAndPlayers(db, api);
    console.log(`teams: upserted ${teams}`);
    const { rows } = await db.query(
      `SELECT count(*)::int AS n, count(team_id)::int AS with_team FROM players`,
    );
    console.log(
      `players: upserted ${players}; table has ${rows[0].n} (${rows[0].with_team} on a current team). ` +
        `${api.requestCount} requests, ${Math.round((Date.now() - started) / 1000)}s`,
    );
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

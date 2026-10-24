// Upsert the 30 current NBA teams and every player from the provider.
// Usage: npm run sync:players
// Players on defunct franchises or without a team get team_id null.
// nba_person_id is never touched (scripts/map-headshots.py owns it).
import "dotenv/config";
import { Pool } from "pg";
import { createClient } from "../src/lib/bdl";
import { upsertPlayers, upsertTeams } from "./lib/upsert";

async function main() {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const api = createClient();
  const started = Date.now();
  try {
    const teams = (await api.teams()).filter((t) => t.isCurrent);
    await upsertTeams(db, teams);
    console.log(`teams: upserted ${teams.length}`);

    let total = 0;
    let pages = 0;
    for await (const page of api.players()) {
      total += await upsertPlayers(db, page.items);
      pages++;
      if (pages % 10 === 0) console.log(`players: ${total} after ${pages} pages`);
    }
    const { rows } = await db.query(
      `SELECT count(*)::int AS n, count(team_id)::int AS with_team FROM players`,
    );
    console.log(
      `players: upserted ${total} in ${pages} pages; table has ${rows[0].n} (${rows[0].with_team} on a current team). ` +
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

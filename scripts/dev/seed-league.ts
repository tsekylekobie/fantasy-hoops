// DEV ONLY: creates a 12-team league with mock managers and drafted rosters,
// so you can sign in as any manager (mock sign-in) and browse as them.
// Re-running replaces the seeded league; it refuses to touch a league that a
// real (non-mock) user owns a team in.
//   npm run db:seed:league            # same rosters every run
//   npm run db:seed:league -- --seed=7  # a different draft
import "dotenv/config";
import { Pool } from "pg";
import { getPlayers } from "../../src/lib/queries/players";
import { CURRENT_SEASON } from "../../src/lib/types";

const LEAGUE_NAME = "Fantasy Hoops";
const ROSTER_SIZE = 13; // 10 starters + 3 bench; IL starts empty
// Filled in this order, most restrictive first.
const STARTER_SLOTS = ["PG", "SG", "SF", "PF", "C", "C", "G", "F", "UTIL", "UTIL"];

// Team names from docs/design/league.mockup.html, plus one to make twelve.
const MANAGERS: { name: string; email: string; team: string; abbr: string }[] = [
  { name: "Maya Okafor", email: "maya@example.com", team: "Fast Break Fund", abbr: "FBF" },
  { name: "Theo Lindqvist", email: "theo@example.com", team: "Glass Cleaners", abbr: "GLC" },
  { name: "Priya Raman", email: "priya@example.com", team: "Back Door Cuts", abbr: "BDC" },
  { name: "Marcus Bell", email: "marcus@example.com", team: "Paint Protectors", abbr: "PNT" },
  { name: "Sofia Alvarez", email: "sofia@example.com", team: "Free Throw Line Dancers", abbr: "FTL" },
  { name: "Jun Park", email: "jun@example.com", team: "Splash Zone", abbr: "SPZ" },
  { name: "Ellie Brennan", email: "ellie@example.com", team: "Corner Three Club", abbr: "CTC" },
  { name: "Dev Patel", email: "dev@example.com", team: "Bench Mob", abbr: "BMB" },
  { name: "Noah Fischer", email: "noah@example.com", team: "Full Court Press", abbr: "FCP" },
  { name: "Ava Thompson", email: "ava@example.com", team: "Pick and Rollers", abbr: "PNR" },
  { name: "Luca Moretti", email: "luca@example.com", team: "Euro Steppers", abbr: "EUS" },
  { name: "Grace Kim", email: "grace@example.com", team: "Moving Screens", abbr: "MVS" },
];

// Deterministic PRNG so runs are reproducible.
let seed = Number(process.argv.find((a) => a.startsWith("--seed="))?.slice(7) ?? 42);
function rand() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}

/** Lineup slots a BALLDONTLIE position string ("G", "F-C", "") can fill. */
function eligibleSlots(position: string | null): Set<string> {
  const slots = new Set(["UTIL"]);
  for (const p of (position ?? "").split("-")) {
    if (p === "G") ["PG", "SG", "G"].forEach((s) => slots.add(s));
    if (p === "F") ["SF", "PF", "F"].forEach((s) => slots.add(s));
    if (p === "C") slots.add("C");
  }
  return slots;
}

interface Pick {
  id: number;
  position: string | null;
}

/** Best-ranked eligible player for each starter slot; the rest go to the bench. */
function assignSlots(roster: Pick[]): Map<number, string> {
  const slots = new Map<number, string>();
  for (const slot of STARTER_SLOTS) {
    const p = roster.find((r) => !slots.has(r.id) && eligibleSlots(r.position).has(slot));
    if (p) slots.set(p.id, slot);
  }
  for (const r of roster) if (!slots.has(r.id)) slots.set(r.id, "BN");
  return slots;
}

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("refusing to seed a production database");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });

  // Draft board: last full season's 9CAT value ranking.
  const board: Pick[] = [];
  for (let page = 1; board.length < MANAGERS.length * ROSTER_SIZE * 2; page++) {
    const res = await getPlayers(db, {
      season: CURRENT_SEASON - 1, range: "season", sort: "value", dir: "desc",
      mode: "avg", q: "", pos: "all", page, perPage: 100,
    });
    if (res.players.length === 0) break;
    board.push(...res.players.map((p) => ({ id: p.id, position: p.position })));
  }
  if (board.length < MANAGERS.length * ROSTER_SIZE) {
    throw new Error(`only ${board.length} players with ${CURRENT_SEASON - 1} stats; run the backfill first`);
  }

  // Snake draft in a random order; each pick is one of the top 3 left.
  const order = MANAGERS.map((_, i) => i).sort(() => rand() - 0.5);
  const rosters: Pick[][] = MANAGERS.map(() => []);
  for (let round = 0; round < ROSTER_SIZE; round++) {
    for (const t of round % 2 === 0 ? order : [...order].reverse()) {
      rosters[t].push(board.splice(Math.floor(rand() * 3), 1)[0]);
    }
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: realOwners } = await client.query(
      `SELECT u.email FROM leagues l
         JOIN fantasy_teams ft ON ft.league_id = l.id
         JOIN users u ON u.id = ft.owner_user_id
        WHERE l.name = $1 AND l.season = $2 AND u.google_sub NOT LIKE 'mock:%'`,
      [LEAGUE_NAME, CURRENT_SEASON],
    );
    if (realOwners.length > 0) {
      throw new Error(`league has real owners (${realOwners.map((r) => r.email).join(", ")}); not replacing it`);
    }
    await client.query(`DELETE FROM leagues WHERE name = $1 AND season = $2`, [LEAGUE_NAME, CURRENT_SEASON]);
    const { rows: [league] } = await client.query<{ id: string }>(
      `INSERT INTO leagues (name, season) VALUES ($1, $2) RETURNING id`,
      [LEAGUE_NAME, CURRENT_SEASON],
    );

    for (const [i, m] of MANAGERS.entries()) {
      // Same googleSub convention as mock sign-in, so these users can sign in.
      const { rows: [user] } = await client.query<{ id: string }>(
        `INSERT INTO users (google_sub, email, name) VALUES ($1, $2, $3)
         ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
         RETURNING id`,
        [`mock:${m.email}`, m.email, m.name],
      );
      // Waiver priority starts as the reverse of the draft order.
      const { rows: [team] } = await client.query<{ id: string }>(
        `INSERT INTO fantasy_teams (league_id, owner_user_id, name, abbreviation, waiver_priority)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [league.id, user.id, m.team, m.abbr, MANAGERS.length - order.indexOf(i)],
      );
      const slots = assignSlots(rosters[i]);
      for (const p of rosters[i]) {
        await client.query(
          `INSERT INTO roster_players (league_id, player_id, fantasy_team_id, slot) VALUES ($1, $2, $3, $4)`,
          [league.id, p.id, team.id, slots.get(p.id)],
        );
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log(`Seeded "${LEAGUE_NAME}" ${CURRENT_SEASON}: ${MANAGERS.length} teams × ${ROSTER_SIZE} players.`);
  console.log("Managers (mock sign-in):");
  for (const m of MANAGERS) console.log(`  ${m.email.padEnd(20)} ${m.name.padEnd(16)} ${m.team}`);
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

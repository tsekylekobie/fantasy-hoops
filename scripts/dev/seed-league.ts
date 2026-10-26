// DEV ONLY: creates a 12-team league with mock managers, drafted rosters,
// matchup weeks and a regular-season schedule, so you can sign in as any
// manager (mock sign-in) and browse as them. League settings are the
// column defaults (see db/migrations/0004_league_play.sql).
// Re-running replaces the seeded league; it refuses to touch a league that a
// real (non-mock) user owns a team in.
//   npm run db:seed:league            # same rosters every run
//   npm run db:seed:league -- --seed=7  # a different draft and schedule
import "dotenv/config";
import { Pool } from "pg";
import { getPlayers } from "../../src/lib/queries/players";
import { CURRENT_SEASON } from "../../src/lib/types";

const LEAGUE_NAME = "Fantasy Hoops";
// Starter slots are filled in this order, most restrictive first.
const FILL_ORDER = ["PG", "SG", "SF", "PF", "C", "G", "F", "UTIL"];

// Team names from docs/design/league.mockup.html, plus one to make twelve.
// The first manager is the commissioner.
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
function assignSlots(roster: Pick[], starterSlots: string[]): Map<number, string> {
  const slots = new Map<number, string>();
  for (const slot of starterSlots) {
    const p = roster.find((r) => !slots.has(r.id) && eligibleSlots(r.position).has(slot));
    if (p) slots.set(p.id, slot);
  }
  for (const r of roster) if (!slots.has(r.id)) slots.set(r.id, "BN");
  return slots;
}

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Mon-Sun weeks covering the season; week 1 runs from opening night to its
 * Sunday. Like Yahoo, the All-Star break (the longest stretch without games
 * that starts in February) is folded into one matchup with the week after it
 * when it spans two weeks. February only: the NBA Cup knockout week in
 * December also looks empty until its games are scheduled.
 */
function matchupWeeks(gameDates: string[]): { starts: string; ends: string }[] {
  const first = new Date(gameDates[0]);
  const last = new Date(gameDates[gameDates.length - 1]);
  const weeks = [];
  for (let start = first; start <= last; ) {
    const end = addDays(start, (7 - start.getUTCDay()) % 7); // through Sunday
    weeks.push({ starts: iso(start), ends: iso(end < last ? end : last) });
    start = addDays(end, 1);
  }

  let breakStart = "";
  let breakEnd = "";
  let longest = 0;
  for (let i = 1; i < gameDates.length; i++) {
    const days = (new Date(gameDates[i]).getTime() - new Date(gameDates[i - 1]).getTime()) / 86_400_000 - 1;
    if (days > longest && gameDates[i - 1].slice(5, 7) === "02") {
      longest = days;
      breakStart = iso(addDays(new Date(gameDates[i - 1]), 1));
      breakEnd = iso(addDays(new Date(gameDates[i]), -1));
    }
  }
  const a = weeks.findIndex((w) => w.starts <= breakStart && breakStart <= w.ends);
  const b = weeks.findIndex((w) => w.starts <= breakEnd && breakEnd <= w.ends);
  if (longest >= 3 && a >= 0 && b > a) weeks.splice(a, b - a + 1, { starts: weeks[a].starts, ends: weeks[b].ends });
  return weeks;
}

/** Round-robin rounds (circle method): every team plays every other once per cycle. */
function roundRobin<T>(teams: T[]): [T, T][][] {
  const rounds = [];
  const ring = [...teams];
  for (let r = 0; r < ring.length - 1; r++) {
    const pairs: [T, T][] = [];
    for (let i = 0; i < ring.length / 2; i++) pairs.push([ring[i], ring[ring.length - 1 - i]]);
    rounds.push(pairs);
    ring.splice(1, 0, ring.pop()!);
  }
  return rounds;
}

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("refusing to seed a production database");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
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

    // Same googleSub convention as mock sign-in, so these users can sign in.
    const userIds: string[] = [];
    for (const m of MANAGERS) {
      const { rows: [user] } = await client.query<{ id: string }>(
        `INSERT INTO users (google_sub, email, name) VALUES ($1, $2, $3)
         ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
         RETURNING id`,
        [`mock:${m.email}`, m.email, m.name],
      );
      userIds.push(user.id);
    }

    const { rows: [league] } = await client.query<{
      id: string;
      roster_slots: Record<string, number>;
      playoff_teams: number;
      waiver_type: string;
      faab_budget: number;
    }>(
      `INSERT INTO leagues (name, season, commissioner_user_id) VALUES ($1, $2, $3)
       RETURNING id, roster_slots, playoff_teams, waiver_type, faab_budget`,
      [LEAGUE_NAME, CURRENT_SEASON, userIds[0]],
    );
    const starterSlots = FILL_ORDER.flatMap((s) => Array<string>(league.roster_slots[s] ?? 0).fill(s));
    // IL starts empty, so a full roster is starters + bench.
    const rosterSize = starterSlots.length + (league.roster_slots.BN ?? 0);

    // Draft board: last full season's 9CAT value ranking.
    const board: Pick[] = [];
    for (let page = 1; board.length < MANAGERS.length * rosterSize * 2; page++) {
      const res = await getPlayers(db, {
        season: CURRENT_SEASON - 1, range: "season", sort: "value", dir: "desc",
        mode: "avg", scope: "all", q: "", pos: "all", plays: [], waivers: "any", page, perPage: 100,
      });
      if (res.players.length === 0) break;
      board.push(...res.players.map((p) => ({ id: p.id, position: p.position })));
    }
    if (board.length < MANAGERS.length * rosterSize) {
      throw new Error(`only ${board.length} players with ${CURRENT_SEASON - 1} stats; run the backfill first`);
    }

    // Snake draft in a random order; each pick is one of the top 3 left.
    const order = MANAGERS.map((_, i) => i).sort(() => rand() - 0.5);
    const rosters: Pick[][] = MANAGERS.map(() => []);
    for (let round = 0; round < rosterSize; round++) {
      for (const t of round % 2 === 0 ? order : [...order].reverse()) {
        rosters[t].push(board.splice(Math.floor(rand() * 3), 1)[0]);
      }
    }

    const teamIds: string[] = [];
    for (const [i, m] of MANAGERS.entries()) {
      // Waiver priority starts as the reverse of the draft order.
      const { rows: [team] } = await client.query<{ id: string }>(
        `INSERT INTO fantasy_teams (league_id, owner_user_id, name, abbreviation, waiver_priority, faab_balance)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [league.id, userIds[i], m.team, m.abbr, MANAGERS.length - order.indexOf(i),
          league.waiver_type === "faab" ? league.faab_budget : null],
      );
      teamIds.push(team.id);
      const slots = assignSlots(rosters[i], starterSlots);
      for (const p of rosters[i]) {
        await client.query(
          `INSERT INTO roster_players (league_id, player_id, fantasy_team_id, slot) VALUES ($1, $2, $3, $4)`,
          [league.id, p.id, team.id, slots.get(p.id)],
        );
      }
    }

    // Weeks span the NBA regular season; the last ones are playoffs, one week
    // per round (6 teams: a bye round for the top 2, semis, final).
    // As text: pg parses `date` at local midnight, and the week math is in UTC.
    const { rows: gameDays } = await client.query<{ date: string }>(
      `SELECT DISTINCT date::text AS date FROM games WHERE season = $1 AND game_type = 'regular' ORDER BY 1`,
      [CURRENT_SEASON],
    );
    if (gameDays.length === 0) throw new Error(`no ${CURRENT_SEASON} schedule; run the backfill first`);
    const weeks = matchupWeeks(gameDays.map((g) => g.date));
    const playoffRounds = Math.ceil(Math.log2(league.playoff_teams));
    const playoffStart = weeks.length - playoffRounds + 1;
    for (const [i, w] of weeks.entries()) {
      await client.query(
        `INSERT INTO league_weeks (league_id, week, starts_on, ends_on, is_playoffs) VALUES ($1, $2, $3, $4, $5)`,
        [league.id, i + 1, w.starts, w.ends, i + 1 >= playoffStart],
      );
    }
    await client.query(`UPDATE leagues SET playoff_start_week = $2 WHERE id = $1`, [league.id, playoffStart]);

    // Regular season: repeat a shuffled round robin until the playoffs.
    const rounds = roundRobin([...teamIds].sort(() => rand() - 0.5));
    for (let week = 1; week < playoffStart; week++) {
      for (const [a, b] of rounds[(week - 1) % rounds.length]) {
        await client.query(
          `INSERT INTO matchups (league_id, week, team_a_id, team_b_id) VALUES ($1, $2, $3, $4)`,
          [league.id, week, a, b],
        );
      }
    }
    await client.query("COMMIT");

    console.log(`Seeded "${LEAGUE_NAME}" ${CURRENT_SEASON}: ${MANAGERS.length} teams × ${rosterSize} players, ` +
      `${weeks.length} weeks (playoffs from week ${playoffStart}).`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log("Managers (mock sign-in; the first is commissioner):");
  for (const m of MANAGERS) console.log(`  ${m.email.padEnd(20)} ${m.name.padEnd(16)} ${m.team}`);
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// DEV ONLY: fills an empty database with a small synthetic dataset so the
// queries can be exercised before the real backfill lands. Refuses to run
// against a database that already has players.
//   DATABASE_URL=postgres://localhost:5432/fantasy_hoops_queries npx tsx scripts/dev/seed-synthetic.ts
import "dotenv/config";
import { Client } from "pg";

// Deterministic PRNG so runs are reproducible.
let seed = 42;
function rand() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const pois = (mean: number) => {
  // Knuth; fine for small means.
  const l = Math.exp(-Math.max(mean, 0));
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > l);
  return k - 1;
};

const FIRST = ["Luka", "Nikola", "José", "Tomáš", "Jalen", "Andre", "Kofi", "Ryan", "Isaiah", "Nico", "Dāvis", "Bogdan", "Şengün", "Marcus", "Devin"];
const LAST = ["Dončić", "Jokić", "Alvarado", "Satoranský", "Brunson", "Drummond", "Mensah", "Calloway", "Brandt", "Santoro", "Bertāns", "Bogdanović", "Alperen", "Smart", "Booker"];
const POS = ["G", "F", "C", "G-F", "F-C", "C-F", "F-G", ""];

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const { rows } = await db.query("SELECT count(*)::int AS n FROM players");
  if (rows[0].n > 0) throw new Error("players table is not empty; refusing to seed");

  await db.query("BEGIN");
  for (let t = 1; t <= 30; t++) {
    await db.query(
      "INSERT INTO teams (id, abbreviation, city, name, full_name) VALUES ($1,$2,$3,$4,$5)",
      [t, `T${String(t).padStart(2, "0")}`, `City${t}`, `Team${t}`, `City${t} Team${t}`],
    );
  }
  // 300 players, 10 per team; talent drives usage.
  const players: { id: number; team: number; talent: number; pos: string }[] = [];
  for (let i = 1; i <= 300; i++) {
    const team = ((i - 1) % 30) + 1;
    const p = { id: i, team, talent: rand(), pos: pick(POS) };
    players.push(p);
    await db.query(
      "INSERT INTO players (id, first_name, last_name, position, team_id) VALUES ($1,$2,$3,$4,$5)",
      [i, `${pick(FIRST)}${i}`, pick(LAST), p.pos || null, team],
    );
  }

  let gameId = 1;
  let statId = 1;
  // 2024 and 2025 full-ish seasons, 2026 just started; one postseason game in 2025.
  const plan: [number, number, boolean][] = [
    [2024, 20, false],
    [2025, 20, false],
    [2025, 1, true],
    [2026, 3, false],
  ];
  for (const [season, rounds, postseason] of plan) {
    for (let r = 0; r < rounds; r++) {
      const order = [...Array(30).keys()].map((x) => x + 1).sort(() => rand() - 0.5);
      for (let g = 0; g < 15; g++) {
        const home = order[2 * g];
        const away = order[2 * g + 1];
        const final = !(season === 2026 && r === rounds - 1 && g === 0);
        const hs = 95 + Math.floor(rand() * 30);
        const vs = 95 + Math.floor(rand() * 30);
        const date = new Date(Date.UTC(season, 9, 22 + r * 2));
        await db.query(
          `INSERT INTO games (id, date, season, status, postseason, home_team_id, visitor_team_id, home_team_score, visitor_team_score)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [gameId, date.toISOString().slice(0, 10), season, final ? "Final" : "2nd Qtr", postseason, home, away, hs, vs === hs ? vs + 1 : vs],
        );
        for (const p of players.filter((x) => x.team === home || x.team === away)) {
          const dnp = rand() < 0.1 + (1 - p.talent) * 0.15;
          const min = dnp ? 0 : Math.round((12 + p.talent * 24 + rand() * 6) * 100) / 100;
          const f = min / 36;
          const fga = dnp ? 0 : pois((6 + p.talent * 14) * f);
          const fgm = Math.min(fga, pois(fga * (0.42 + rand() * 0.1)));
          const fg3a = Math.min(fga, pois(fga * 0.35));
          const fg3m = Math.min(fg3a, fgm, pois(fg3a * 0.36));
          const fta = dnp ? 0 : pois((1 + p.talent * 6) * f);
          const ftm = Math.min(fta, pois(fta * 0.78));
          const oreb = dnp ? 0 : pois(1 * f);
          const dreb = dnp ? 0 : pois((2 + p.talent * 6) * f);
          await db.query(
            `INSERT INTO player_game_stats (id, player_id, game_id, team_id, season, min, fgm, fga, fg3m, fg3a, ftm, fta,
               oreb, dreb, reb, ast, stl, blk, turnover, pf, pts)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
            [statId++, p.id, gameId, p.team, season, min, fgm, fga, fg3m, fg3a, ftm, fta, oreb, dreb, oreb + dreb,
              dnp ? 0 : pois((1 + p.talent * 6) * f), dnp ? 0 : pois(1 * f), dnp ? 0 : pois((p.pos.includes("C") ? 1.5 : 0.4) * f),
              dnp ? 0 : pois((1 + p.talent * 2) * f), dnp ? 0 : pois(2 * f), 2 * fgm + fg3m + ftm],
          );
        }
        gameId++;
      }
    }
  }
  await db.query("COMMIT");
  console.log(`Seeded ${players.length} players, ${gameId - 1} games, ${statId - 1} stat rows.`);
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

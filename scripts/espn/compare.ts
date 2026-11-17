// Compares ESPN's box scores for a date with the stat lines we have stored
// (from BALLDONTLIE), matched through players/games.espn_id. Read-only: run it
// while BALLDONTLIE is still the provider to see how far the two disagree.
//
//   npm run espn:compare                          # yesterday (US Eastern)
//   npm run espn:compare -- --date 2026-11-16     # one date; repeat or comma-separate for more
//
// Lists stat lines on one side only and every stat that differs. Minutes are
// compared to the whole minute (ESPN gives whole minutes, BALLDONTLIE mm:ss).
// Run scripts/espn/match-ids.ts first, or most players show as not linked.
import "dotenv/config";
import { Pool } from "pg";
import { EspnHttp } from "../../src/lib/espn/http";
import { boxAthletes, isStoredGame, toStatLines, ymd } from "../../src/lib/espn/map";
import type { EspnScoreboardResponse, EspnSummaryResponse } from "../../src/lib/espn/raw";

const FIELDS = ["min", "pts", "fgm", "fga", "fg3m", "fg3a", "ftm", "fta", "oreb", "dreb", "reb", "ast", "stl", "blk", "turnover", "pf", "plus_minus"] as const;
type Field = (typeof FIELDS)[number];
type Line = Record<Field, number | null>;

function parseDates(argv: string[]): string[] {
  const dates: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--date") dates.push(...(argv[++i] ?? "").split(","));
    else if (argv[i].startsWith("--date=")) dates.push(...argv[i].slice(7).split(","));
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!dates.length) {
    const d = new Date(Date.now() - 86_400_000);
    dates.push(d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }));
  }
  for (const d of dates) if (!/^\d{4}-\d{2}-\d{2}$/.test(d.trim())) throw new Error(`--date takes yyyy-mm-dd, not "${d}"`);
  return dates.map((d) => d.trim());
}

async function main() {
  const dates = parseDates(process.argv.slice(2));
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const http = new EspnHttp();
  const total = { compared: 0, differing: 0, espnOnly: 0, oursOnly: 0, unlinked: 0 };
  const fieldDiffs = new Map<Field, number>();
  try {
    const { rows: players } = await db.query<{ id: number; espn_id: number; name: string }>(
      `SELECT id, espn_id, first_name || ' ' || last_name AS name FROM players WHERE espn_id IS NOT NULL`,
    );
    const ourPlayer = new Map(players.map((p) => [p.espn_id, p.id]));
    const names = new Map(players.map((p) => [p.id, p.name]));

    for (const date of dates) {
      console.log(`\n== ${date}`);
      const sb = await http.get<EspnScoreboardResponse>("scoreboard", { dates: ymd(date), limit: 100 });
      for (const e of sb.events.filter(isStoredGame)) {
        const label = `${e.name ?? e.id} (ESPN ${e.id})`;
        const { rows: [game] } = await db.query<{ id: number }>(`SELECT id FROM games WHERE espn_id = $1`, [Number(e.id)]);
        if (!game) {
          console.log(`${label}: not linked to one of our games (scripts/espn/match-ids.ts)`);
          continue;
        }
        const summary = await http.get<EspnSummaryResponse>("summary", { event: e.id });
        const unlinked = boxAthletes(summary).filter((a) => !ourPlayer.has(a.espnId));
        const espn = new Map<number, Line>();
        for (const l of toStatLines(summary, { gameId: game.id, players: ourPlayer })) {
          espn.set(l.playerId, {
            min: l.min, pts: l.pts, fgm: l.fgm, fga: l.fga, fg3m: l.fg3m, fg3a: l.fg3a, ftm: l.ftm, fta: l.fta, oreb: l.oreb,
            dreb: l.dreb, reb: l.reb, ast: l.ast, stl: l.stl, blk: l.blk, turnover: l.turnover, pf: l.pf, plus_minus: l.plusMinus,
          });
        }
        const { rows: stored } = await db.query<Line & { player_id: number }>(
          `SELECT player_id, ${FIELDS.map((f) => (f === "min" ? "min::float8 AS min" : f)).join(", ")}
             FROM player_game_stats WHERE game_id = $1`,
          [game.id],
        );
        const ours = new Map(stored.map((r) => [r.player_id, r]));
        const problems: string[] = [];
        for (const a of unlinked) problems.push(`  not linked: ${a.firstName} ${a.lastName} (ESPN ${a.espnId})`);
        for (const [pid, l] of espn) {
          const o = ours.get(pid);
          if (!o) {
            if ((l.min ?? 0) > 0) problems.push(`  only on ESPN: ${names.get(pid)} (${l.min} min, ${l.pts} pts)`);
            if ((l.min ?? 0) > 0) total.espnOnly++;
            continue;
          }
          total.compared++;
          const diffs: string[] = [];
          for (const f of FIELDS) {
            const a = o[f] == null ? null : Number(o[f]);
            const b = l[f];
            const same = f === "min" ? Math.abs((a ?? 0) - (b ?? 0)) < 1 : f === "plus_minus" && (a === null || b === null) ? true : a === b;
            if (!same) {
              diffs.push(`${f} ${a} vs ${b}`);
              fieldDiffs.set(f, (fieldDiffs.get(f) ?? 0) + 1);
            }
          }
          if (diffs.length) {
            total.differing++;
            problems.push(`  ${names.get(pid)}: ${diffs.join(", ")} (ours vs ESPN)`);
          }
        }
        for (const [pid, o] of ours) {
          if (!espn.has(pid) && Number(o.min ?? 0) > 0) {
            total.oursOnly++;
            problems.push(`  only ours: ${names.get(pid) ?? `player ${pid}, not linked`} (${o.min} min, ${o.pts} pts)`);
          }
        }
        total.unlinked += unlinked.length;
        console.log(`${label}: ${espn.size} ESPN lines, ${ours.size} ours${problems.length ? "" : ", all the same"}`);
        for (const p of problems) console.log(p);
      }
    }
    console.log(
      `\n${total.compared} lines compared, ${total.differing} differ` +
        (fieldDiffs.size ? ` (${[...fieldDiffs].map(([f, n]) => `${f} ${n}`).join(", ")})` : "") +
        `; ${total.espnOnly} only on ESPN, ${total.oursOnly} only ours, ${total.unlinked} ESPN players not linked. ${http.requestCount} ESPN requests.`,
    );
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

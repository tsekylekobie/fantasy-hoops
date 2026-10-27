// Saves a Yahoo league as it stands right now into a snapshot folder, for
// scripts/yahoo/import.ts. Run it on the day you import (the import refuses a
// snapshot from another day):
//   npm run yahoo:export -- --league 12345                 # -> yahoo-export/12345
//   npm run yahoo:export -- --league 466.l.12345 --out my-dir
//
// The folder (gitignored) holds Yahoo's raw JSON under raw/, so the import can
// be re-run, or fixed, without asking Yahoo again:
//   raw/league-settings.json, raw/teams.json, raw/game-weeks.json
//   raw/scoreboard/week-NN.json       every week: the schedule, and past weeks' results
//   raw/rosters/<date>/<team>.json    every team's lineup on every day so far
//   raw/transactions/page-NNN.json    the season's adds, drops and trades
//   raw/waivers/page-NNN.json         players on waivers now
//   meta.json                         league key, when, and "today"
// Past weeks' scoreboards and past days' rosters already in the folder are not
// fetched again. It also writes members.csv (fill in each manager's Gmail) the
// first time. See README, "Importing from Yahoo".
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { abbreviate, content, parseGameWeeks, parseLeague, parseTeams, toCsv } from "../../src/lib/yahoo/parse";
import { YahooClient } from "./client";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** yyyy-mm-dd in `timeZone`. */
const localDate = (d: Date, timeZone: string) => d.toLocaleDateString("en-CA", { timeZone });
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Runs `tasks` a few at a time (Yahoo doesn't like bursts). */
async function pool<T>(tasks: (() => Promise<T>)[], size = 4): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  }));
  return out;
}

async function main() {
  const league = arg("league");
  if (!league) throw new Error("Usage: npm run yahoo:export -- --league <league id or key> [--out <dir>]");
  const yahoo = await YahooClient.connect();

  // "12345" -> this season's NBA game key + ".l.12345".
  const gameKey = league.includes(".l.") ? league.split(".l.")[0] : String(content(await yahoo.get("game/nba"), "game").game_key);
  const leagueKey = league.includes(".l.") ? league : `${gameKey}.l.${league}`;
  const dir = arg("out") ?? join("yahoo-export", leagueKey.split(".l.")[1]);
  const save = (path: string, json: unknown) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), JSON.stringify(json, null, 1));
  };
  const have = (path: string) => existsSync(join(dir, path));

  // Days follow the league's time zone: league-settings.json's, if you've written one.
  const overrides = have("league-settings.json") ? JSON.parse(readFileSync(join(dir, "league-settings.json"), "utf8")) : {};
  const timeZone: string = overrides.timeZone ?? "America/New_York";
  const exportedAt = new Date();
  const today = localDate(exportedAt, timeZone);

  console.log(`Exporting ${leagueKey} to ${dir} (today is ${today}, ${timeZone})`);
  const settingsJson = await yahoo.get(`league/${leagueKey}/settings`);
  save("raw/league-settings.json", settingsJson);
  const info = parseLeague(settingsJson);
  const teamsJson = await yahoo.get(`league/${leagueKey}/teams`);
  save("raw/teams.json", teamsJson);
  const teams = parseTeams(teamsJson);
  const weeksJson = await yahoo.get(`game/${gameKey}/game_weeks`);
  save("raw/game-weeks.json", weeksJson);
  const weeks = parseGameWeeks(weeksJson).filter((w) => w.week >= info.startWeek && w.week <= info.endWeek);
  console.log(`  ${info.name}: ${teams.length} teams, weeks ${info.startWeek}-${info.endWeek}`);

  const scoreboards = weeks.filter((w) => !(w.end < today && have(`raw/scoreboard/week-${String(w.week).padStart(2, "0")}.json`)));
  await pool(scoreboards.map((w) => async () => {
    save(`raw/scoreboard/week-${String(w.week).padStart(2, "0")}.json`, await yahoo.get(`league/${leagueKey}/scoreboard;week=${w.week}`));
  }));
  console.log(`  scoreboards: ${scoreboards.length} fetched, ${weeks.length - scoreboards.length} already saved`);

  const last = info.endDate && info.endDate < today ? info.endDate : today;
  const rosterTasks: (() => Promise<void>)[] = [];
  for (let d = info.startDate; d <= last; d = addDays(d, 1)) {
    for (const t of teams) {
      const path = `raw/rosters/${d}/${t.key}.json`;
      if (d < today && have(path)) continue;
      const date = d;
      rosterTasks.push(async () => save(path, await yahoo.get(`team/${t.key}/roster;date=${date}`)));
    }
  }
  await pool(rosterTasks);
  console.log(`  rosters: ${rosterTasks.length} team-days fetched (${info.startDate} to ${last})`);

  // Paged 25 at a time; a short page is the last.
  const pages = async (path: (start: number) => string, folder: string, key: string) => {
    let n = 0;
    for (let start = 0; ; start += 25, n++) {
      const json = await yahoo.get(path(start));
      save(`raw/${folder}/page-${String(n).padStart(3, "0")}.json`, json);
      const coll = (content(json, "league") as Record<string, Record<string, unknown>>)[key];
      if (!coll || Number(coll.count ?? 0) < 25) return n + 1;
    }
  };
  const txPages = await pages((s) => `league/${leagueKey}/transactions;start=${s};count=25`, "transactions", "transactions");
  const wPages = await pages((s) => `league/${leagueKey}/players;status=W;start=${s};count=25;out=ownership`, "waivers", "players");
  console.log(`  transactions: ${txPages} pages, waivers: ${wPages} pages`);

  save("meta.json", { leagueKey, gameKey, exportedAt: exportedAt.toISOString(), today, timeZone });

  if (!have("members.csv")) {
    const taken = new Set<string>();
    writeFileSync(join(dir, "members.csv"), toCsv(
      ["yahoo_team_key", "team", "manager", "email", "commissioner", "abbreviation"],
      teams.map((t) => {
        const abbr = abbreviate(t.name, taken);
        taken.add(abbr);
        return {
          yahoo_team_key: t.key, team: t.name,
          manager: t.managers.map((m) => m.nickname).join(" / "),
          email: t.managers.find((m) => m.email)?.email ?? "",
          commissioner: t.managers.some((m) => m.isCommissioner) ? "yes" : "",
          abbreviation: abbr,
        };
      }),
    ));
    console.log(`\nWrote ${join(dir, "members.csv")}: fill in each manager's Gmail, then run the import (dry run):`);
  } else {
    console.log("\nNext, a dry run of the import:");
  }
  console.log(`  npm run yahoo:import -- ${dir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

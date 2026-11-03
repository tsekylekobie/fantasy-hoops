// A league snapshot from hand-made CSVs instead of Yahoo's API, for the Yahoo
// import (scripts/yahoo/import.ts) when the API isn't available. Builds the same
// ImportSnapshot the API export does, so everything after loading is shared.
// Pure, so it can be unit tested. Files, all in one folder:
//   league.json    {name, season, today, rosterSlots, playoffStartWeek?, settings?}
//                  today: the date rosters.csv reflects (yyyy-mm-dd, league time)
//   teams.csv      team,name,abbreviation,email,commissioner,waiver_priority,faab_balance
//   schedule.csv   week,start,end,team_a,team_b   (one row per matchup; a week with no
//                  matchups, e.g. playoffs, can be a row with the teams blank)
//   results.csv    week,team,fgm,fga,ftm,fta,fg3m,pts,reb,ast,stl,blk,tov   (finished weeks)
//   rosters.csv    team,player,nba_team,positions,slot   (today)
//   lineups.csv    date,team,player,nba_team,positions,slot   (optional: earlier days)
// `team` is any short id used across the files (e.g. 1-12). `slot` is a Yahoo
// position (PG ... Util, BN, IL, IL+); `positions` is the player's eligible
// positions, separated by "/" (optional, only used in messages).
import type { CategoryLine, LineupSlot } from "../types";
import {
  YAHOO_STAT_IDS,
  normalizeName,
  parseCsv,
  toNbaAbbr,
  toSlot,
  type ImportSnapshot,
  type YahooLeague,
  type YahooMatchup,
  type YahooPlayer,
  type YahooRosterEntry,
} from "./parse";

export interface CsvFiles {
  league: unknown;
  teams: string;
  schedule: string;
  results: string;
  rosters: string;
  lineups?: string;
}

export interface CsvLeague {
  name: string;
  season: number;
  today: string;
  rosterSlots: Record<string, number>;
  playoffStartWeek?: number | null;
  settings?: YahooLeague["settings"];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATS = ["fgm", "fga", "ftm", "fta", "fg3m", "pts", "reb", "ast", "stl", "blk", "tov"] as const;

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** A player as the import sees him; the key is his name and NBA team, so the same player matches across files. */
export function csvPlayer(name: string, nbaTeam: string, positions = ""): YahooPlayer {
  const full = name.trim();
  const team = toNbaAbbr(nbaTeam.trim());
  const space = full.indexOf(" ");
  return {
    key: `${normalizeName(full)}|${team}`,
    first: space < 0 ? full : full.slice(0, space),
    last: space < 0 ? "" : full.slice(space + 1),
    full,
    team,
    eligiblePositions: positions.split(/[/,]/).map((p) => p.trim()).filter(Boolean),
  };
}

/** The snapshot, plus every problem found (the import refuses to apply while there are any). */
export function snapshotFromCsv(files: CsvFiles): { snapshot: ImportSnapshot; members: Record<string, string>[]; errors: string[] } {
  const errors: string[] = [];
  const l = (files.league ?? {}) as Partial<CsvLeague>;
  if (!l.name) errors.push("league.json: name is missing.");
  if (!Number.isInteger(l.season)) errors.push("league.json: season is missing (2026 = 2026-27).");
  if (!l.today || !DATE.test(l.today)) errors.push("league.json: today is missing (yyyy-mm-dd, the date rosters.csv reflects).");
  const today = l.today ?? "";

  const rosterSlots: Partial<Record<LineupSlot, number>> = {};
  for (const [pos, n] of Object.entries(l.rosterSlots ?? {})) {
    const slot = toSlot(pos);
    if (!slot || !Number.isInteger(n) || n < 0) errors.push(`league.json: rosterSlots "${pos}": ${n} isn't a slot and count.`);
    else if (n > 0) rosterSlots[slot] = (rosterSlots[slot] ?? 0) + n;
  }
  if (Object.keys(rosterSlots).length === 0) errors.push("league.json: rosterSlots is missing (e.g. {\"PG\": 1, \"SG\": 1, ..., \"BN\": 3, \"IL\": 2}).");

  // --- Teams ---
  const teamRows = parseCsv(files.teams);
  const keyOf = new Map<string, string>();
  for (const [i, r] of teamRows.entries()) {
    const id = r.team ?? "";
    if (!id || !r.name) errors.push(`teams.csv row ${i + 2}: team and name are required.`);
    else if (keyOf.has(id)) errors.push(`teams.csv: team "${id}" is listed twice.`);
    else keyOf.set(id, `csv.t.${id}`);
  }
  const key = (file: string, row: number, id: string): string | null => {
    const k = keyOf.get(id.trim());
    if (!k) errors.push(`${file} row ${row}: no team "${id}" in teams.csv.`);
    return k ?? null;
  };
  const num = (file: string, row: number, col: string, v: string | undefined, blank: number | null): number | null => {
    if (v === undefined || v.trim() === "") return blank;
    const n = Number(v);
    if (!Number.isFinite(n)) errors.push(`${file} row ${row}: ${col} "${v}" isn't a number.`);
    return Number.isFinite(n) ? n : blank;
  };
  const teams = teamRows.filter((r) => keyOf.has(r.team)).map((r, i) => ({
    key: keyOf.get(r.team)!,
    name: r.name,
    managers: [],
    waiverPriority: num("teams.csv", i + 2, "waiver_priority", r.waiver_priority, null),
    faabBalance: num("teams.csv", i + 2, "faab_balance", r.faab_balance, null),
  }));
  const members = teamRows.filter((r) => keyOf.has(r.team)).map((r) => ({
    yahoo_team_key: keyOf.get(r.team)!,
    email: r.email ?? "",
    commissioner: r.commissioner ?? "",
    abbreviation: r.abbreviation ?? "",
  }));

  // --- Weeks and matchups ---
  const weeks = new Map<number, { week: number; start: string; end: string }>();
  const pairs: { week: number; a: string; b: string }[] = [];
  for (const [i, r] of parseCsv(files.schedule).entries()) {
    const row = i + 2;
    const week = Number(r.week);
    if (!Number.isInteger(week) || week < 1) { errors.push(`schedule.csv row ${row}: week "${r.week}" isn't a week number.`); continue; }
    if (!DATE.test(r.start ?? "") || !DATE.test(r.end ?? "") || r.start > r.end) { errors.push(`schedule.csv row ${row}: start and end must be dates (yyyy-mm-dd), start first.`); continue; }
    const w = weeks.get(week);
    if (w && (w.start !== r.start || w.end !== r.end)) errors.push(`schedule.csv row ${row}: week ${week} has different dates than an earlier row.`);
    weeks.set(week, { week, start: r.start, end: r.end });
    if (!r.team_a && !r.team_b) continue;
    const [a, b] = [key("schedule.csv", row, r.team_a ?? ""), key("schedule.csv", row, r.team_b ?? "")];
    if (a && b) pairs.push({ week, a, b });
  }
  const sorted = [...weeks.values()].sort((x, y) => x.week - y.week);
  for (const [i, w] of sorted.entries()) {
    if (w.week !== i + 1) { errors.push(`schedule.csv: weeks must run 1, 2, 3, ... (week ${i + 1} is missing).`); break; }
    if (i > 0 && w.start <= sorted[i - 1].end) errors.push(`schedule.csv: week ${w.week} starts before week ${w.week - 1} ends.`);
  }

  const results = new Map<string, CategoryLine>();
  for (const [i, r] of parseCsv(files.results).entries()) {
    const row = i + 2;
    const k = key("results.csv", row, r.team ?? "");
    const week = Number(r.week);
    if (!weeks.has(week)) errors.push(`results.csv row ${row}: no week ${r.week} in schedule.csv.`);
    if (!k || !weeks.has(week)) continue;
    const v = Object.fromEntries(STATS.map((s) => [s, num("results.csv", row, s, r[s], NaN) ?? NaN])) as Record<(typeof STATS)[number], number>;
    const missing = STATS.filter((s) => !Number.isFinite(v[s]));
    if (missing.length > 0) { errors.push(`results.csv row ${row}: ${missing.join(", ")} missing.`); continue; }
    results.set(`${week}:${k}`, {
      fgm: v.fgm, fga: v.fga, fgPct: v.fga > 0 ? r3(v.fgm / v.fga) : null,
      ftm: v.ftm, fta: v.fta, ftPct: v.fta > 0 ? r3(v.ftm / v.fta) : null,
      fg3m: v.fg3m, pts: v.pts, reb: v.reb, ast: v.ast, stl: v.stl, blk: v.blk, tov: v.tov,
    });
  }
  const zero: CategoryLine = { fgm: 0, fga: 0, fgPct: null, ftm: 0, fta: 0, ftPct: null, fg3m: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0 };
  const playoffStartWeek = l.playoffStartWeek ?? null;
  const matchups: YahooMatchup[] = pairs.map(({ week, a, b }) => {
    const w = weeks.get(week)!;
    const finished = w.end < today;
    for (const k of [a, b]) {
      if (finished && !results.has(`${week}:${k}`)) errors.push(`results.csv: week ${week} has ended but has no row for team "${k.slice(6)}".`);
    }
    return {
      week,
      status: finished ? "postevent" : w.start <= today ? "midevent" : "preevent",
      isPlayoffs: playoffStartWeek !== null && week >= playoffStartWeek,
      teams: [a, b].map((k) => ({ key: k, line: results.get(`${week}:${k}`) ?? zero })),
    };
  });

  // --- Rosters (today) and earlier lineups ---
  const rosters = new Map<string, Map<string, YahooRosterEntry[]>>();
  const addEntry = (file: string, row: number, date: string, r: Record<string, string>) => {
    const k = key(file, row, r.team ?? "");
    if (!r.player) { errors.push(`${file} row ${row}: player is missing.`); return; }
    if (!r.slot || toSlot(r.slot) === null) errors.push(`${file} row ${row}: slot "${r.slot ?? ""}" isn't a position (PG, SG, G, SF, PF, F, C, Util, BN, IL, IL+).`);
    if (!k) return;
    const byTeam = rosters.get(date) ?? new Map<string, YahooRosterEntry[]>();
    rosters.set(date, byTeam);
    const list = byTeam.get(k) ?? [];
    byTeam.set(k, list);
    list.push({ player: csvPlayer(r.player, r.nba_team ?? "", r.positions ?? ""), position: r.slot ?? "BN" });
  };
  for (const [i, r] of parseCsv(files.rosters).entries()) addEntry("rosters.csv", i + 2, today, r);
  for (const [i, r] of parseCsv(files.lineups ?? "").entries()) {
    if (!DATE.test(r.date ?? "") || r.date >= today) errors.push(`lineups.csv row ${i + 2}: date "${r.date ?? ""}" must be a day before today (${today}).`);
    else addEntry("lineups.csv", i + 2, r.date, r);
  }
  for (const t of teams) if (!rosters.get(today)?.has(t.key)) errors.push(`rosters.csv: no players for team "${t.key.slice(6)}".`);

  const league: YahooLeague = {
    key: "csv",
    name: l.name ?? "",
    season: l.season ?? 0,
    numTeams: teams.length,
    startWeek: 1,
    endWeek: sorted.length,
    startDate: sorted[0]?.start ?? "",
    endDate: sorted.at(-1)?.end ?? "",
    rosterSlots,
    statIds: Object.values(YAHOO_STAT_IDS),
    playoffStartWeek,
    settings: l.settings ?? {},
  };
  return {
    snapshot: {
      meta: { leagueKey: "csv", exportedAt: today, today },
      league,
      teams,
      weeks: sorted,
      matchups,
      rosters: new Map([...rosters].sort(([x], [y]) => x.localeCompare(y))),
      transactions: [],
      waivers: [],
    },
    members,
    errors,
  };
}

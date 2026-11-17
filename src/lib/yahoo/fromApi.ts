// Yahoo Fantasy API responses (?format=json) as an ImportSnapshot (parse.ts),
// for apply.ts. Pure, so it can be unit tested against fixtures (fixtures/).
//
// Yahoo's JSON is a mechanical translation of its XML, so it's awkward and
// we read it loosely:
//   - a resource is an array of parts: league = [ {metadata}, {settings: ...} ];
//     a team's or player's metadata is itself an array of one-key objects
//     ([{team_key}, {name}, [], {managers: [...]}]). `merge` folds all of that
//     into one object.
//   - a collection is an object with numeric keys and a count:
//     {"0": {team: ...}, "1": {team: ...}, "count": 2}. Sometimes it's an array
//     of the same wrappers ([{manager: ...}]). `list` reads both.
//   - numbers and flags often come as strings ("12", "1"); `num`/`flag` take both.
//   - a sub-collection sometimes sits under "0" (scoreboard["0"].matchups,
//     roster["0"].players) and sometimes directly; `sub` looks in both places.
// Every assumption about a shape is listed in README "Yahoo API: what we assume".
import type { CategoryLine, LineupSlot } from "../types";
import {
  YAHOO_STAT_IDS,
  toSlot,
  type ImportSnapshot,
  type YahooLeague,
  type YahooMatchup,
  type YahooMove,
  type YahooPlayer,
  type YahooRosterEntry,
  type YahooStanding,
  type YahooTeam,
  type YahooTransaction,
  type YahooWeek,
} from "./parse";

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

/** Folds Yahoo's arrays of one-key objects (nested to any depth) into one object. Later keys win. */
export function merge(x: unknown): Obj {
  if (isObj(x)) return { ...x };
  const out: Obj = {};
  if (Array.isArray(x)) for (const el of x) Object.assign(out, merge(el));
  return out;
}

/** The `name` items of a Yahoo collection, in order: {"0": {name: ...}, count} or [{name: ...}]. */
export function list(coll: unknown, name: string): unknown[] {
  if (Array.isArray(coll)) return coll.map((el) => (isObj(el) ? el[name] : undefined)).filter((v) => v !== undefined);
  if (!isObj(coll)) return [];
  return Object.keys(coll)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => (isObj(coll[k]) ? (coll[k] as Obj)[name] : undefined))
    .filter((v) => v !== undefined);
}

/** A sub-collection that Yahoo puts either at obj[key] or at obj["0"][key]. */
function sub(obj: unknown, key: string): unknown {
  if (!isObj(obj)) return undefined;
  if (obj[key] !== undefined) return obj[key];
  const zero = obj["0"];
  if (isObj(zero) && zero[key] !== undefined) return zero[key];
  if (Array.isArray(zero)) return merge(zero)[key];
  return undefined;
}

export function num(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x !== "string" || x.trim() === "" || x.trim() === "-") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
const str = (x: unknown): string => (typeof x === "string" ? x : typeof x === "number" ? String(x) : "");
const flag = (x: unknown): boolean => x === true || x === 1 || x === "1" || x === "true";

/** fantasy_content's resource (league, team, game, users) as its merged parts. */
function resource(json: unknown, name: string): Obj {
  const fc = isObj(json) ? (json.fantasy_content as unknown) : undefined;
  if (!isObj(fc) || fc[name] === undefined) throw new Error(`Yahoo response has no fantasy_content.${name}`);
  return merge(fc[name]);
}

// --- Players ---

export function apiPlayer(p: unknown): { player: YahooPlayer; selected: string | null; transactionData: Obj[] } {
  const m = merge(p);
  const name = isObj(m.name) ? m.name : {};
  const full = str(name.full) || [str(name.first), str(name.last)].filter(Boolean).join(" ");
  const eligible = list(m.eligible_positions, "position").map(str).filter(Boolean);
  const selected = merge(m.selected_position).position;
  const td = m.transaction_data;
  return {
    player: {
      key: str(m.player_key),
      first: str(name.first) || full.split(" ")[0] || "",
      last: str(name.last) || full.split(" ").slice(1).join(" "),
      full,
      team: str(m.editorial_team_abbr).toUpperCase(),
      eligiblePositions: eligible,
    },
    selected: selected === undefined ? null : str(selected),
    transactionData: Array.isArray(td) ? td.filter(isObj) : isObj(td) ? [td] : [],
  };
}

// --- League metadata and settings ---

export interface LeagueMeta {
  key: string;
  gameKey: string;
  name: string;
  season: number;
  numTeams: number;
  currentWeek: number | null;
  startWeek: number;
  endWeek: number;
  startDate: string;
  endDate: string;
  isFinished: boolean;
}

/** league/{key}/settings (or any league response): the league's metadata. */
export function leagueMeta(json: unknown): LeagueMeta {
  const l = resource(json, "league");
  const key = str(l.league_key);
  if (!key) throw new Error("Yahoo league response has no league_key");
  return {
    key,
    gameKey: key.split(".l.")[0],
    name: str(l.name),
    season: num(l.season) ?? 0,
    numTeams: num(l.num_teams) ?? 0,
    currentWeek: num(l.current_week),
    startWeek: num(l.start_week) ?? 1,
    endWeek: num(l.end_week) ?? 0,
    startDate: str(l.start_date),
    endDate: str(l.end_date),
    isFinished: flag(l.is_finished),
  };
}

/** league/{key}/settings as our YahooLeague (weeks' dates aside, which come from game_weeks). */
export function leagueFromApi(json: unknown, warnings: string[] = []): YahooLeague {
  const meta = leagueMeta(json);
  const s = merge(resource(json, "league").settings);

  const rosterSlots: Partial<Record<LineupSlot, number>> = {};
  for (const rp of list(s.roster_positions, "roster_position")) {
    const r = merge(rp);
    const slot = toSlot(str(r.position));
    const count = num(r.count) ?? 0;
    if (!slot) warnings.push(`Yahoo roster position "${str(r.position)}" has no slot here; left out.`);
    else if (count > 0) rosterSlots[slot] = (rosterSlots[slot] ?? 0) + count;
  }
  const statIds = list(sub(s.stat_categories, "stats") ?? merge(s.stat_categories).stats, "stat")
    .map(merge)
    .filter((st) => !flag(st.is_only_display_stat) && st.enabled !== "0" && st.enabled !== 0)
    .map((st) => str(st.stat_id));

  const settings: YahooLeague["settings"] = {};
  if (s.uses_faab !== undefined || s.waiver_type !== undefined) {
    settings.waiverType = flag(s.uses_faab) || str(s.waiver_type).toUpperCase().includes("F") ? "faab" : "continual_rolling";
  }
  const waiverDays = num(s.waiver_time);
  if (waiverDays !== null) settings.waiverDays = waiverDays;
  const ratify = str(s.trade_ratify_type).toLowerCase();
  if (ratify) settings.tradeReview = ratify.startsWith("commish") || ratify.startsWith("commission") ? "commissioner" : ratify === "vote" ? "league_vote" : "none";
  const rejectDays = num(s.trade_reject_time);
  if (rejectDays !== null) settings.tradeReviewDays = rejectDays;
  if (s.trade_end_date !== undefined) settings.tradeDeadline = /^\d{4}-\d{2}-\d{2}$/.test(str(s.trade_end_date)) ? str(s.trade_end_date) : null;
  if (s.max_weekly_adds !== undefined) settings.maxAddsPerWeek = num(s.max_weekly_adds) || null;
  if (s.max_adds !== undefined) settings.maxAddsPerSeason = num(s.max_adds) || null;
  const usesPlayoff = s.uses_playoff === undefined || flag(s.uses_playoff);
  const playoffTeams = num(s.num_playoff_teams);
  if (usesPlayoff && playoffTeams) settings.playoffTeams = playoffTeams;

  return {
    key: meta.key,
    name: meta.name,
    season: meta.season,
    numTeams: meta.numTeams,
    startWeek: meta.startWeek,
    endWeek: meta.endWeek,
    startDate: meta.startDate,
    endDate: meta.endDate,
    rosterSlots,
    statIds,
    playoffStartWeek: usesPlayoff ? num(s.playoff_start_week) : null,
    settings,
  };
}

/** game/{game_key}/game_weeks: every week's dates, limited to the league's weeks. */
export function weeksFromApi(json: unknown, startWeek: number, endWeek: number): YahooWeek[] {
  const g = resource(json, "game");
  return list(g.game_weeks, "game_week")
    .map(merge)
    .map((w) => ({ week: num(w.week) ?? 0, start: str(w.start), end: str(w.end) }))
    .filter((w) => w.week >= startWeek && w.week <= endWeek && w.start && w.end)
    .sort((a, b) => a.week - b.week);
}

// --- Teams and standings ---

function teamParts(t: unknown): Obj {
  return merge(t);
}

/** league/{key}/teams: teams with managers, waiver priority and FAAB. */
export function teamsFromApi(json: unknown): YahooTeam[] {
  const l = resource(json, "league");
  return list(l.teams, "team").map(teamParts).map((t) => ({
    key: str(t.team_key),
    name: str(t.name),
    managers: list(t.managers, "manager").map(merge).map((m) => ({
      nickname: str(m.nickname),
      email: str(m.email) || null,
      isCommissioner: flag(m.is_commissioner),
    })),
    waiverPriority: num(t.waiver_priority),
    faabBalance: num(t.faab_balance),
  })).filter((t) => t.key);
}

/** league/{key}/standings. */
export function standingsFromApi(json: unknown): YahooStanding[] {
  const l = resource(json, "league");
  const standings = Array.isArray(l.standings) ? merge(l.standings) : isObj(l.standings) ? l.standings : {};
  return list(standings.teams ?? sub(standings, "teams"), "team").map(teamParts).map((t) => {
    const ts = merge(t.team_standings);
    const o = merge(ts.outcome_totals);
    return { key: str(t.team_key), rank: num(ts.rank), wins: num(o.wins) ?? 0, losses: num(o.losses) ?? 0, ties: num(o.ties) ?? 0 };
  }).filter((t) => t.key);
}

// --- Scoreboard ---

const r3 = (x: number) => Math.round(x * 1000) / 1000;
/** Yahoo's display-only stat ids for made/attempted: "FGM/FGA" and "FTM/FTA" ("250/531"). */
const FG_SPLIT = "9004003";
const FT_SPLIT = "9007006";

/** A team_stats block as our CategoryLine. Blank values ("" or "-", before a week starts) count as zero. */
export function lineFromStats(teamStats: unknown): CategoryLine {
  const stats = new Map(list(merge(teamStats).stats, "stat").map(merge).map((s) => [str(s.stat_id), s.value]));
  const n = (id: string) => num(stats.get(id)) ?? 0;
  const split = (id: string): [number, number] | null => {
    const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(str(stats.get(id)));
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const pct = (id: string, s: [number, number] | null): number | null => {
    if (s) return s[1] > 0 ? r3(s[0] / s[1]) : null;
    const p = num(stats.get(id));
    return p === null ? null : r3(p);
  };
  const fg = split(FG_SPLIT);
  const ft = split(FT_SPLIT);
  return {
    fgm: fg?.[0] ?? 0, fga: fg?.[1] ?? 0, fgPct: pct(YAHOO_STAT_IDS.fgPct, fg),
    ftm: ft?.[0] ?? 0, fta: ft?.[1] ?? 0, ftPct: pct(YAHOO_STAT_IDS.ftPct, ft),
    fg3m: n(YAHOO_STAT_IDS.fg3m), pts: n(YAHOO_STAT_IDS.pts), reb: n(YAHOO_STAT_IDS.reb), ast: n(YAHOO_STAT_IDS.ast),
    stl: n(YAHOO_STAT_IDS.stl), blk: n(YAHOO_STAT_IDS.blk), tov: n(YAHOO_STAT_IDS.tov),
  };
}

/** league/{key}/scoreboard;week=N: that week's matchups with each team's totals so far, plus the week's dates. */
export function scoreboardFromApi(json: unknown): { matchups: YahooMatchup[]; weeks: YahooWeek[] } {
  const l = resource(json, "league");
  const sb = isObj(l.scoreboard) ? l.scoreboard : merge(l.scoreboard);
  const fallbackWeek = num(sb.week);
  const weeks = new Map<number, YahooWeek>();
  const matchups = list(sub(sb, "matchups"), "matchup").map(merge).map((m): YahooMatchup => {
    const week = num(m.week) ?? fallbackWeek ?? 0;
    if (str(m.week_start) && str(m.week_end)) weeks.set(week, { week, start: str(m.week_start), end: str(m.week_end) });
    return {
      week,
      status: str(m.status) || "preevent",
      isPlayoffs: flag(m.is_playoffs),
      isConsolation: flag(m.is_consolation),
      teams: list(sub(m, "teams"), "team").map(teamParts).map((t) => ({ key: str(t.team_key), line: lineFromStats(t.team_stats) })),
    };
  });
  return { matchups, weeks: [...weeks.values()] };
}

// --- Rosters ---

/** team/{team_key}/roster;date=yyyy-mm-dd: the team's key, the roster's date and each player's position that day. */
export function rosterFromApi(json: unknown): { teamKey: string; date: string | null; entries: YahooRosterEntry[] } {
  const t = resource(json, "team");
  const roster = isObj(t.roster) ? t.roster : merge(t.roster);
  const entries = list(sub(roster, "players"), "player").map(apiPlayer).map(({ player, selected }) => ({
    player,
    position: selected ?? "BN",
  }));
  return { teamKey: str(t.team_key), date: str(roster.date) || null, entries };
}

// --- Transactions ---

/** "yyyy-mm-dd HH:MM" in UTC from Yahoo's unix timestamp (seconds). */
export function utcMinute(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * league/{key}/transactions: completed ("successful") adds, drops, claims and
 * trades. Times are UTC (the snapshot's transactionsTimeZone).
 */
export function transactionsFromApi(json: unknown, warnings: string[] = []): YahooTransaction[] {
  const l = resource(json, "league");
  const out: YahooTransaction[] = [];
  for (const raw of list(l.transactions, "transaction")) {
    const tx = merge(raw);
    const key = str(tx.transaction_key);
    if (!key || (str(tx.status) && str(tx.status) !== "successful")) continue;
    const seconds = num(tx.timestamp);
    if (seconds === null) {
      warnings.push(`Yahoo transaction ${key} has no timestamp; skipped.`);
      continue;
    }
    const moves: YahooMove[] = [];
    let fromWaivers = false;
    for (const p of list(tx.players, "player")) {
      const { player, transactionData } = apiPlayer(p);
      for (const d of transactionData) {
        const from = str(d.source_type) === "team" ? str(d.source_team_key) || null : null;
        const to = str(d.destination_type) === "team" ? str(d.destination_team_key) || null : null;
        if (str(d.source_type) === "waivers") fromWaivers = true;
        if (from || to) moves.push({ player, from, to });
      }
    }
    if (moves.length === 0) continue;
    const yType = str(tx.type).toLowerCase();
    const between = moves.some((m) => m.from && m.to);
    const adds = moves.some((m) => m.to && !m.from);
    const drops = moves.some((m) => m.from && !m.to);
    const type: YahooTransaction["type"] = between || yType === "trade" ? "trade" : fromWaivers ? "waiver_claim" : adds && drops ? "add_drop" : adds ? "add" : "drop";
    let team: string;
    let tradeTeam: string | null = null;
    if (type === "trade") {
      const sides = [...new Set([str(tx.trader_team_key), str(tx.tradee_team_key), ...moves.flatMap((m) => [m.from, m.to])].filter((k): k is string => !!k))];
      if (sides.length !== 2) {
        warnings.push(`Yahoo trade ${key} is between ${sides.length} teams; only two-team trades are mirrored.`);
        continue;
      }
      [team, tradeTeam] = sides;
    } else {
      const teams = [...new Set(moves.map((m) => m.to ?? m.from!))];
      if (teams.length !== 1) {
        warnings.push(`Yahoo transaction ${key} (${yType}) moves players for ${teams.length} teams; skipped.`);
        continue;
      }
      team = teams[0];
    }
    out.push({
      id: key,
      at: utcMinute(seconds),
      type,
      team,
      tradeTeam,
      faabBid: type === "waiver_claim" ? num(tx.faab_bid) : null,
      moves,
      failureReason: null,
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** How many transactions a page of league/{key}/transactions holds, any status (to know the last page). */
export function transactionCount(json: unknown): number {
  return list(resource(json, "league").transactions, "transaction").length;
}

// --- The user's leagues (to pick one after connecting) ---

/** users;use_login=1/games;game_codes=nba/leagues: the connected account's NBA leagues. */
export function userLeaguesFromApi(json: unknown): { key: string; name: string; season: number }[] {
  const fc = isObj(json) ? json.fantasy_content : undefined;
  const users = isObj(fc) ? fc.users : undefined;
  const out: { key: string; name: string; season: number }[] = [];
  for (const u of list(users, "user")) {
    for (const g of list(merge(u).games, "game")) {
      for (const l of list(merge(g).leagues, "league")) {
        const m = merge(l);
        if (str(m.league_key)) out.push({ key: str(m.league_key), name: str(m.name), season: num(m.season) ?? 0 });
      }
    }
  }
  return out;
}

// --- The snapshot ---

/** The raw responses one sync fetched. Only settings and teams are required. */
export interface ApiResponses {
  settings: unknown;
  teams: unknown;
  gameWeeks?: unknown;
  standings?: unknown;
  scoreboards?: unknown[];
  /** Each roster response, by the date it was asked for. */
  rosters?: { date: string; json: unknown }[];
  /** Pages of league/{key}/transactions. */
  transactions?: unknown[];
}

/**
 * The snapshot apply.ts writes. `today` is the league's date (rosters for it
 * are "today's"). Parts not fetched are empty: no rosters, no matchups for the
 * weeks not asked for, no transactions; apply.ts leaves those alone.
 */
export function snapshotFromApi(r: ApiResponses, today: string, exportedAt: string): { snapshot: ImportSnapshot; warnings: string[] } {
  const warnings: string[] = [];
  const league = leagueFromApi(r.settings, warnings);
  const teams = teamsFromApi(r.teams);

  const weeks = new Map<number, YahooWeek>();
  if (r.gameWeeks) for (const w of weeksFromApi(r.gameWeeks, league.startWeek, league.endWeek)) weeks.set(w.week, w);
  const matchups: YahooMatchup[] = [];
  for (const sb of r.scoreboards ?? []) {
    const parsed = scoreboardFromApi(sb);
    for (const w of parsed.weeks) weeks.set(w.week, w);
    matchups.push(...parsed.matchups);
  }

  const rosters = new Map<string, Map<string, YahooRosterEntry[]>>();
  for (const { date, json } of r.rosters ?? []) {
    const parsed = rosterFromApi(json);
    if (parsed.date && parsed.date !== date) warnings.push(`Yahoo answered ${parsed.teamKey}'s roster for ${date} with ${parsed.date}'s.`);
    const byTeam = rosters.get(date) ?? new Map<string, YahooRosterEntry[]>();
    rosters.set(date, byTeam);
    byTeam.set(parsed.teamKey, parsed.entries);
  }

  const seen = new Set<string>();
  const transactions = (r.transactions ?? []).flatMap((page) => transactionsFromApi(page, warnings))
    .filter((t) => !seen.has(t.id) && seen.add(t.id))
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id, undefined, { numeric: true }));

  return {
    snapshot: {
      meta: { leagueKey: league.key, exportedAt, today },
      league,
      teams,
      weeks: [...weeks.values()].sort((a, b) => a.week - b.week),
      matchups: matchups.sort((a, b) => a.week - b.week),
      rosters: new Map([...rosters].sort(([x], [y]) => x.localeCompare(y))),
      transactions,
      transactionsTimeZone: "UTC",
      ...(r.standings !== undefined && { standings: standingsFromApi(r.standings) }),
    },
    warnings,
  };
}

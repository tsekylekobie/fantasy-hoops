// Reading the Yahoo Fantasy Sports API's JSON (?format=json), for the Yahoo
// import (scripts/yahoo/). Pure functions, so they can be unit tested.
//
// Yahoo's JSON is a mechanical translation of its XML: a resource is an array
// of fragments ([{team_key}, {team_id}, [], {name}, ...] for its metadata,
// then {roster: ...} etc. for subresources), and a collection is an object
// keyed "0", "1", ... with a "count". `merge` and `items` undo both.
import type { CategoryLine, LineupSlot, TradeReview, WaiverOrder } from "../types";

type Obj = Record<string, unknown>;

const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

/** One object from a resource's fragments: [[{a}, {b}], {c}, []] -> {a, b, c}. */
export function merge(x: unknown): Obj {
  if (isObj(x)) return x;
  const out: Obj = {};
  if (Array.isArray(x)) for (const part of x) Object.assign(out, merge(part));
  return out;
}

/** The `key` entries of a collection ({"0": {key: ...}, "1": ..., count} or [{key: ...}]), in order. */
export function items(coll: unknown, key: string): unknown[] {
  const values = Array.isArray(coll)
    ? coll
    : isObj(coll)
      ? Object.keys(coll).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b)).map((k) => coll[k])
      : [];
  return values.map((v) => (isObj(v) ? v[key] : undefined)).filter((v) => v !== undefined);
}

/** `obj[key]`, or the first `obj["0"][key]`-style child that has it (Yahoo nests subcollections under "0"). */
export function child(obj: unknown, key: string): unknown {
  if (!isObj(obj)) return undefined;
  if (key in obj) return obj[key];
  for (const k of Object.keys(obj).filter((k) => /^\d+$/.test(k))) {
    const v = obj[k];
    if (isObj(v) && key in v) return v[key];
  }
  return undefined;
}

/** The resource under fantasy_content (league, team, game), merged. */
export function content(json: unknown, resource: string): Obj {
  return merge(isObj(json) && isObj(json.fantasy_content) ? json.fantasy_content[resource] : undefined);
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const int = (v: unknown): number | null => {
  const n = Number.parseInt(str(v), 10);
  return Number.isFinite(n) ? n : null;
};
const flag = (v: unknown) => str(v) === "1";

export interface YahooPlayer {
  /** e.g. "466.p.6014". */
  key: string;
  first: string;
  last: string;
  full: string;
  /** Yahoo's NBA team abbreviation ("GS", "NY", "LAL"); "" for free agents. */
  team: string;
  eligiblePositions: string[];
}

export function parsePlayer(raw: unknown): YahooPlayer {
  const p = merge(raw);
  const name = merge(p.name);
  return {
    key: str(p.player_key),
    first: str(name.ascii_first || name.first),
    last: str(name.ascii_last || name.last),
    full: str(name.full),
    team: str(p.editorial_team_abbr).toUpperCase(),
    eligiblePositions: items(p.eligible_positions, "position").map(str),
  };
}

/** Yahoo lineup positions as our slots. "Util" is UTIL; anything unknown is null (callers bench it). */
export function toSlot(position: string): LineupSlot | null {
  const p = position.trim().toUpperCase();
  if (p === "UTIL") return "UTIL";
  if (p === "BN") return "BN";
  return (["PG", "SG", "G", "SF", "PF", "F", "C", "IL", "IL+"] as const).find((s) => s === p) ?? null;
}

export interface YahooTeam {
  key: string;
  name: string;
  /** Managers' nicknames, and emails where Yahoo shares them. */
  managers: { nickname: string; email: string | null; isCommissioner: boolean }[];
  waiverPriority: number | null;
  faabBalance: number | null;
}

/** league/{key}/teams */
export function parseTeams(json: unknown): YahooTeam[] {
  return items(child(content(json, "league"), "teams"), "team").map((raw) => {
    const t = merge(raw);
    return {
      key: str(t.team_key),
      name: str(t.name),
      managers: items(t.managers, "manager").map((m) => {
        const mm = merge(m);
        return { nickname: str(mm.nickname), email: str(mm.email) || null, isCommissioner: flag(mm.is_commissioner) };
      }),
      waiverPriority: int(t.waiver_priority),
      faabBalance: int(t.faab_balance),
    };
  });
}

/** A roster entry: the player and the Yahoo position he's in that day ("BN", "Util", "IL", ...). */
export interface YahooRosterEntry {
  player: YahooPlayer;
  position: string;
}

/** team/{key}/roster;date=... */
export function parseRoster(json: unknown): YahooRosterEntry[] {
  const roster = content(json, "team").roster;
  return items(child(roster, "players"), "player").map((raw) => ({
    player: parsePlayer(raw),
    position: str(merge(merge(raw).selected_position).position),
  }));
}

export interface YahooWeek {
  week: number;
  start: string;
  end: string;
}

/** game/{key}/game_weeks */
export function parseGameWeeks(json: unknown): YahooWeek[] {
  return items(child(content(json, "game"), "game_weeks"), "game_week").map((raw) => {
    const w = merge(raw);
    return { week: int(w.week) ?? 0, start: str(w.start), end: str(w.end) };
  });
}

// Yahoo's NBA stat ids for the nine categories, plus the makes/attempts it
// shows beside FG% and FT% ("123/456").
export const YAHOO_STAT_IDS = {
  fgPct: "5", ftPct: "8", fg3m: "10", pts: "12", reb: "15", ast: "16", stl: "17", blk: "18", tov: "19",
} as const;
const FGM_FGA = "9004003";
const FTM_FTA = "9007006";

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * A team's week as a CategoryLine from Yahoo's team_stats ({stats: [{stat: {stat_id, value}}]}).
 * Percentages come from the makes and attempts when Yahoo sends them (as our
 * scoring does), else from its rounded percentage. "-" (no games) is 0.
 */
export function parseTeamStats(teamStats: unknown): CategoryLine {
  const byId = new Map(items(child(teamStats, "stats"), "stat").map((s) => [str(merge(s).stat_id), str(merge(s).value)]));
  const n = (id: string) => Number.parseFloat(byId.get(id) ?? "") || 0;
  const pair = (id: string) => (byId.get(id) ?? "").split("/").map((x) => Number.parseInt(x, 10));
  const pct = (pairId: string, pctId: string): [number, number, number | null] => {
    const [m, a] = pair(pairId);
    if (Number.isFinite(m) && Number.isFinite(a)) return [m, a, a > 0 ? r3(m / a) : null];
    const v = Number.parseFloat(byId.get(pctId) ?? "");
    return [0, 0, Number.isFinite(v) ? r3(v) : null];
  };
  const [fgm, fga, fgPct] = pct(FGM_FGA, YAHOO_STAT_IDS.fgPct);
  const [ftm, fta, ftPct] = pct(FTM_FTA, YAHOO_STAT_IDS.ftPct);
  return {
    fgm, fga, fgPct, ftm, fta, ftPct,
    fg3m: n(YAHOO_STAT_IDS.fg3m), pts: n(YAHOO_STAT_IDS.pts), reb: n(YAHOO_STAT_IDS.reb),
    ast: n(YAHOO_STAT_IDS.ast), stl: n(YAHOO_STAT_IDS.stl), blk: n(YAHOO_STAT_IDS.blk), tov: n(YAHOO_STAT_IDS.tov),
  };
}

export interface YahooMatchup {
  week: number;
  /** "preevent" | "midevent" | "postevent" */
  status: string;
  isPlayoffs: boolean;
  teams: { key: string; line: CategoryLine }[];
}

/** league/{key}/scoreboard;week=N */
export function parseScoreboard(json: unknown): YahooMatchup[] {
  const scoreboard = content(json, "league").scoreboard;
  return items(child(scoreboard, "matchups"), "matchup").map((raw) => {
    const m = merge(raw);
    return {
      week: int(m.week) ?? 0,
      status: str(m.status),
      isPlayoffs: flag(m.is_playoffs),
      teams: items(child(m, "teams"), "team").map((t) => {
        const tt = merge(t);
        return { key: str(tt.team_key), line: parseTeamStats(tt.team_stats) };
      }),
    };
  });
}

export interface YahooTransaction {
  key: string;
  /** "add" | "drop" | "add/drop" | "trade" | "commish" */
  type: string;
  status: string;
  /** Unix seconds. */
  timestamp: number;
  faabBid: number | null;
  traderTeamKey: string | null;
  tradeeTeamKey: string | null;
  players: {
    player: YahooPlayer;
    /** "add" | "drop" | "trade" */
    type: string;
    /** "freeagents" | "waivers" | "team" */
    sourceType: string;
    sourceTeamKey: string | null;
    destinationType: string;
    destinationTeamKey: string | null;
  }[];
}

/** One page of league/{key}/transactions. */
export function parseTransactions(json: unknown): YahooTransaction[] {
  return items(child(content(json, "league"), "transactions"), "transaction").map((raw) => {
    const t = merge(raw);
    return {
      key: str(t.transaction_key),
      type: str(t.type),
      status: str(t.status),
      timestamp: int(t.timestamp) ?? 0,
      faabBid: int(t.faab_bid),
      traderTeamKey: str(t.trader_team_key) || null,
      tradeeTeamKey: str(t.tradee_team_key) || null,
      players: items(t.players, "player").map((p) => {
        const d = merge(merge(p).transaction_data);
        return {
          player: parsePlayer(p),
          type: str(d.type),
          sourceType: str(d.source_type),
          sourceTeamKey: str(d.source_team_key) || null,
          destinationType: str(d.destination_type),
          destinationTeamKey: str(d.destination_team_key) || null,
        };
      }),
    };
  });
}

/** One page of league/{key}/players;status=W;out=ownership: players on waivers and the date they clear. */
export function parseWaivers(json: unknown): { player: YahooPlayer; clearsOn: string | null }[] {
  return items(child(content(json, "league"), "players"), "player").map((raw) => ({
    player: parsePlayer(raw),
    clearsOn: str(merge(merge(raw).ownership).waiver_date) || null,
  }));
}

export interface YahooLeague {
  key: string;
  name: string;
  /** Yahoo's season year, same convention as ours (2026 = 2026-27). */
  season: number;
  numTeams: number;
  startWeek: number;
  endWeek: number;
  startDate: string;
  endDate: string;
  /** Lineup slots and counts, Yahoo positions mapped to ours. */
  rosterSlots: Partial<Record<LineupSlot, number>>;
  /** Scored stat ids (not display-only). */
  statIds: string[];
  playoffStartWeek: number | null;
  /** The settings we can carry over; everything else keeps our defaults. */
  settings: {
    waiverType?: WaiverOrder["type"];
    waiverDays?: number;
    tradeReview?: TradeReview;
    tradeReviewDays?: number;
    tradeDeadline?: string | null;
    maxAddsPerWeek?: number | null;
    maxAddsPerSeason?: number | null;
    playoffTeams?: number;
  };
}

const TRADE_RATIFY: Record<string, TradeReview> = { commish: "commissioner", vote: "league_vote", none: "none" };

/** league/{key}/settings */
export function parseLeague(json: unknown): YahooLeague {
  const l = content(json, "league");
  const s = merge(l.settings);
  const rosterSlots: Partial<Record<LineupSlot, number>> = {};
  for (const raw of items(s.roster_positions, "roster_position")) {
    const r = merge(raw);
    const slot = toSlot(str(r.position));
    const count = int(r.count) ?? 0;
    if (slot && count > 0) rosterSlots[slot] = (rosterSlots[slot] ?? 0) + count;
  }
  const statIds = items(child(s.stat_categories, "stats"), "stat")
    .map(merge)
    .filter((st) => str(st.enabled ?? "1") === "1" && !flag(st.is_only_display_stat))
    .map((st) => str(st.stat_id));
  const adds = (v: unknown) => {
    const n = int(v);
    return n === null || n <= 0 ? null : n;
  };
  const settings: YahooLeague["settings"] = {};
  if (flag(s.uses_faab)) settings.waiverType = "faab";
  if (int(s.waiver_time) !== null) settings.waiverDays = int(s.waiver_time)!;
  if (TRADE_RATIFY[str(s.trade_ratify_type)]) settings.tradeReview = TRADE_RATIFY[str(s.trade_ratify_type)];
  if (int(s.trade_reject_time) !== null) settings.tradeReviewDays = int(s.trade_reject_time)!;
  if ("trade_end_date" in s) settings.tradeDeadline = /^\d{4}-\d{2}-\d{2}$/.test(str(s.trade_end_date)) ? str(s.trade_end_date) : null;
  if ("max_weekly_adds" in s) settings.maxAddsPerWeek = adds(s.max_weekly_adds);
  if ("max_adds" in s) settings.maxAddsPerSeason = adds(s.max_adds);
  if (int(s.num_playoff_teams) !== null) settings.playoffTeams = int(s.num_playoff_teams)!;
  return {
    key: str(l.league_key),
    name: str(l.name),
    season: int(l.season) ?? 0,
    numTeams: int(l.num_teams) ?? 0,
    startWeek: int(l.start_week) ?? 1,
    endWeek: int(l.end_week) ?? 0,
    startDate: str(l.start_date),
    endDate: str(l.end_date),
    rosterSlots,
    statIds,
    playoffStartWeek: flag(s.uses_playoff) || s.uses_playoff === undefined ? int(s.playoff_start_week) : null,
    settings,
  };
}

// --- Matching Yahoo players to ours (BALLDONTLIE) ---

/** "Nikola Jokić" / "Jaren Jackson Jr." -> "nikola jokic" / "jaren jackson". */
export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'’`-]/g, (c) => (c === "-" ? " " : ""))
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["jr", "sr", "ii", "iii", "iv", "v"].includes(w))
    .join(" ");
}

/** Lowercase without accents or punctuation, suffixes kept: "Trey Murphy III" -> "trey murphy iii". */
const plain = (name: string) => name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Yahoo's team abbreviations that differ from BALLDONTLIE's.
const TEAM_ALIASES: Record<string, string> = { GS: "GSW", NY: "NYK", NO: "NOP", SA: "SAS", PHO: "PHX", UTAH: "UTA", WSH: "WAS", BRK: "BKN", CHO: "CHA" };
export const toNbaAbbr = (yahoo: string) => TEAM_ALIASES[yahoo.toUpperCase()] ?? yahoo.toUpperCase();

export interface OurPlayer {
  id: number;
  firstName: string;
  lastName: string;
  /** Current NBA team abbreviation; null = not on a team. */
  team: string | null;
}

/**
 * Our player id for a Yahoo player: the one with the same normalized name,
 * narrowed by NBA team when several share it, then by the exact name with its
 * suffix (the provider has some players twice: "Trey Murphy", "Trey Murphy III"),
 * then by players on a team.
 * Falls back to same last name + team + first initial (nicknames: "Nic"/"Nicolas").
 * Null when nothing or more than one player fits.
 */
export function matchPlayer(y: YahooPlayer, ours: OurPlayer[]): number | null {
  const full = normalizeName(y.full || `${y.first} ${y.last}`);
  const team = y.team ? toNbaAbbr(y.team) : null;
  const pick = (list: OurPlayer[]): number | null => {
    if (list.length === 1) return list[0].id;
    if (list.length === 0) return null;
    const byTeam = team ? list.filter((p) => p.team === team) : [];
    if (byTeam.length === 1) return byTeam[0].id;
    const exactly = (byTeam.length > 0 ? byTeam : list).filter((p) => plain(`${p.firstName} ${p.lastName}`) === plain(y.full));
    if (exactly.length === 1) return exactly[0].id;
    const active = list.filter((p) => p.team !== null);
    return active.length === 1 ? active[0].id : null;
  };
  const exact = pick(ours.filter((p) => normalizeName(`${p.firstName} ${p.lastName}`) === full));
  if (exact !== null || !team) return exact;
  const last = normalizeName(y.last);
  const initial = normalizeName(y.first).charAt(0);
  const loose = ours.filter((p) => p.team === team && normalizeName(p.lastName) === last && normalizeName(p.firstName).startsWith(initial));
  return loose.length === 1 ? loose[0].id : null;
}

// --- CSV (members.csv, player-overrides.csv) ---

/** Rows of a CSV with a header line, as objects keyed by header. Handles quoted fields. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((f) => f.trim() !== ""));
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

export function toCsv(header: string[], rows: Record<string, string | number | boolean | null>[]): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header.join(","), ...rows.map((r) => header.map((h) => cell(r[h])).join(","))].join("\n") + "\n";
}

/** A 2–4 character abbreviation from a team name ("Fast Break Fund" -> "FBF"), unique among `taken`. */
export function abbreviate(name: string, taken: Set<string>): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const letters = words.join("");
  const candidates = [
    words.map((w) => w[0]).join("").slice(0, 4),
    letters.slice(0, 3),
    letters.slice(0, 4),
  ].filter((c) => /^(?=.*[A-Z])[A-Z0-9]{2,4}$/.test(c));
  for (const c of candidates) if (!taken.has(c)) return c;
  const base = (candidates[0] ?? "TM").slice(0, 3);
  for (let i = 1; ; i++) {
    const c = `${base.slice(0, 4 - String(i).length)}${i}`;
    if (!taken.has(c)) return c;
  }
}

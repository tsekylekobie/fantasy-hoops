// The Yahoo import's shared pieces (scripts/yahoo/import.ts): the snapshot
// shape the CSVs are read into (csv.ts), Yahoo positions and stat ids, matching
// Yahoo players to ours, and CSV reading/writing. Pure, so it can be unit tested.
import type { CategoryLine, LineupSlot, TradeReview, WaiverOrder } from "../types";

export interface YahooPlayer {
  /** A stable key for the player within one snapshot (csv.ts builds it from his name and team). */
  key: string;
  first: string;
  last: string;
  full: string;
  /** Yahoo's NBA team abbreviation ("GS", "NY", "LAL"); "" for free agents. */
  team: string;
  eligiblePositions: string[];
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
  /** Managers' nicknames and emails (emails come from teams.csv instead). */
  managers: { nickname: string; email: string | null; isCommissioner: boolean }[];
  waiverPriority: number | null;
  faabBalance: number | null;
}

/** A roster entry: the player and the Yahoo position he's in that day ("BN", "Util", "IL", ...). */
export interface YahooRosterEntry {
  player: YahooPlayer;
  position: string;
}

export interface YahooWeek {
  week: number;
  start: string;
  end: string;
}

/** Yahoo's NBA stat ids for the nine categories. */
export const YAHOO_STAT_IDS = {
  fgPct: "5", ftPct: "8", fg3m: "10", pts: "12", reb: "15", ast: "16", stl: "17", blk: "18", tov: "19",
} as const;

export interface YahooMatchup {
  week: number;
  /** "preevent" | "midevent" | "postevent" */
  status: string;
  isPlayoffs: boolean;
  teams: { key: string; line: CategoryLine }[];
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
  /** Scored stat ids. */
  statIds: string[];
  playoffStartWeek: number | null;
  /** The settings we carry over; everything else keeps our defaults. */
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

/** One move in a Yahoo transaction: from a team (null = free agents or waivers) to a team (null = dropped). */
export interface YahooMove {
  player: YahooPlayer;
  from: string | null;
  to: string | null;
}

/** A completed Yahoo transaction (transactions.csv); team keys as in `teams`. */
export interface YahooTransaction {
  id: string;
  /** Local time, "yyyy-mm-dd HH:MM", in `ImportSnapshot.transactionsTimeZone` (or the league's). */
  at: string;
  type: "add" | "drop" | "add_drop" | "waiver_claim" | "trade";
  /** Who made it (for a trade, one side) and, for a trade, the other side. */
  team: string;
  tradeTeam: string | null;
  faabBid: number | null;
  moves: YahooMove[];
}

/** Everything the import reads, built from a folder of CSVs (csv.ts). */
export interface ImportSnapshot {
  meta: { leagueKey: string; exportedAt: string; today: string };
  league: YahooLeague;
  teams: YahooTeam[];
  weeks: YahooWeek[];
  matchups: YahooMatchup[];
  /** date -> team key -> that day's roster. */
  rosters: Map<string, Map<string, YahooRosterEntry[]>>;
  /** Completed transactions, oldest first (none without transactions.csv). */
  transactions: YahooTransaction[];
  /** The IANA time zone transactions.csv's times are in; null = the league's. */
  transactionsTimeZone: string | null;
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

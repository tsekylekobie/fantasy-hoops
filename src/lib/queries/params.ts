// Query-string parsing for the /api/players endpoints. Pure, unit tested.
import {
  CATEGORIES,
  CURRENT_SEASON,
  DEFAULT_WEIGHTS,
  MAX_WEIGHT,
  type Category,
  type CategoryWeights,
  PLAY_DAYS,
  SORT_KEYS,
  defaultSortDir,
  type PlayDay,
  type PlayerScope,
  type PositionFilter,
  type SortDir,
  type SortKey,
  type StatMode,
  type StatRange,
  type WaiverFilter,
} from "../types";

export class BadRequest extends Error {}

export interface PlayersQuery {
  season: number;
  range: StatRange;
  sort: SortKey;
  dir: SortDir;
  mode: StatMode;
  scope: PlayerScope;
  q: string;
  pos: PositionFilter;
  /** Empty = any day. Deduplicated, in PLAY_DAYS order. */
  plays: PlayDay[];
  waivers: WaiverFilter;
  /** Players on this fantasy team (fantasy_teams.id); null = any. */
  team: number | null;
  /** Players on this NBA team (teams.abbreviation, uppercase); null = any. */
  nba: string | null;
  weights: CategoryWeights;
  page: number;
  perPage: number;
}

export const DEFAULT_PER_PAGE = 50;
export const MAX_PER_PAGE = 100;

function intParam(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = params.get(name)?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new BadRequest(`${name} must be a positive integer`);
  const n = Number(raw);
  if (n < min || n > max) throw new BadRequest(`${name} must be between ${min} and ${max}`);
  return n;
}

/** A weight from 0 to MAX_WEIGHT, rounded to hundredths; null if it isn't one. */
export function toWeight(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_WEIGHT) return null;
  return Math.round(value * 100) / 100;
}

/** An object with a valid weight for every category, else null. Extra keys are ignored. */
export function toWeights(value: unknown): CategoryWeights | null {
  if (typeof value !== "object" || value === null) return null;
  const out = {} as CategoryWeights;
  for (const c of CATEGORIES) {
    const w = toWeight((value as Partial<Record<Category, unknown>>)[c]);
    if (w === null) return null;
    out[c] = w;
  }
  return out;
}

/** "?weights=1,1,1,1,1,1,1,1,0.25": one number per CATEGORIES entry, in order. Omitted = DEFAULT_WEIGHTS. */
function parseWeights(params: URLSearchParams): CategoryWeights {
  const raw = params.get("weights")?.trim();
  if (!raw) return { ...DEFAULT_WEIGHTS };
  const parts = raw.split(",").map((x) => x.trim());
  const nums = parts.map((x) => (/^\d+(\.\d+)?$/.test(x) ? Number(x) : NaN));
  const weights = parts.length === CATEGORIES.length
    ? toWeights(Object.fromEntries(CATEGORIES.map((c, i) => [c, nums[i]])))
    : null;
  if (!weights) {
    throw new BadRequest(`weights must be ${CATEGORIES.length} numbers from 0 to ${MAX_WEIGHT} (${CATEGORIES.join(", ")})`);
  }
  return weights;
}

export function parseSeason(params: URLSearchParams): number {
  return intParam(params, "season", CURRENT_SEASON, 1946, 2100);
}

export function parsePlayersQuery(params: URLSearchParams): PlayersQuery {
  const mode = params.get("mode")?.trim() || "avg";
  if (mode !== "avg" && mode !== "total") throw new BadRequest("mode must be avg or total");
  const range = params.get("range")?.trim() || "season";
  if (range !== "season" && range !== "last14") throw new BadRequest("range must be season or last14");
  const sort = (params.get("sort")?.trim() || "value") as SortKey;
  if (!SORT_KEYS.includes(sort)) throw new BadRequest(`sort must be one of ${SORT_KEYS.join(", ")}`);
  const dir = params.get("dir")?.trim() || defaultSortDir(sort);
  if (dir !== "asc" && dir !== "desc") throw new BadRequest("dir must be asc or desc");
  const scope = params.get("scope")?.trim() || "all";
  if (scope !== "fa" && scope !== "all") throw new BadRequest("scope must be fa or all");
  const pos = params.get("pos")?.trim().toUpperCase() || "ALL";
  if (!["ALL", "G", "F", "C"].includes(pos)) throw new BadRequest("pos must be all, G, F or C");
  const plays = (params.get("plays") ?? "").split(",").map((d) => d.trim()).filter(Boolean);
  for (const d of plays) {
    if (!(PLAY_DAYS as readonly string[]).includes(d)) throw new BadRequest(`plays must be a list of ${PLAY_DAYS.join(", ")}`);
  }
  const waivers = params.get("waivers")?.trim() || "any";
  if (waivers !== "any" && waivers !== "on" && waivers !== "clears") throw new BadRequest("waivers must be any, on or clears");
  const nba = params.get("nba")?.trim().toUpperCase() || null;
  if (nba !== null && !/^[A-Z]{2,4}$/.test(nba)) throw new BadRequest("nba must be a team abbreviation, e.g. BOS");
  return {
    season: parseSeason(params),
    range,
    sort,
    dir,
    mode,
    scope,
    q: (params.get("q") ?? "").trim().slice(0, 100),
    pos: (pos === "ALL" ? "all" : pos) as PositionFilter,
    plays: PLAY_DAYS.filter((d) => plays.includes(d)),
    waivers,
    team: params.get("team")?.trim() ? intParam(params, "team", 0, 1, 2147483647) : null,
    nba,
    weights: parseWeights(params),
    page: intParam(params, "page", 1, 1, 100000),
    perPage: intParam(params, "perPage", DEFAULT_PER_PAGE, 1, MAX_PER_PAGE),
  };
}

export function parsePlayerId(raw: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 2147483647) {
    throw new BadRequest("id must be a positive integer");
  }
  return Number(raw);
}

/** Lowercase, strip accents and punctuation, collapse whitespace: "Dončić, Luka" -> "doncic luka". */
export function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when every word of the query is a prefix-or-substring of the name ("luk don" matches "Luka Dončić"). */
export function nameMatches(query: string, firstName: string, lastName: string): boolean {
  const q = normalizeName(query);
  if (!q) return true;
  const name = normalizeName(`${firstName} ${lastName}`);
  return q.split(" ").every((w) => name.includes(w));
}

/** "G-F" matches G and F; "all" matches everything (including players with no position). */
export function positionMatches(filter: PositionFilter, position: string | null): boolean {
  if (filter === "all") return true;
  return (position ?? "").toUpperCase().includes(filter);
}

// Query-string parsing for the /api/players endpoints. Pure, unit tested.
import {
  CURRENT_SEASON,
  SORT_KEYS,
  defaultSortDir,
  type PlayerScope,
  type PositionFilter,
  type SortDir,
  type SortKey,
  type StatMode,
  type StatRange,
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
  return {
    season: parseSeason(params),
    range,
    sort,
    dir,
    mode,
    scope,
    q: (params.get("q") ?? "").trim().slice(0, 100),
    pos: (pos === "ALL" ? "all" : pos) as PositionFilter,
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

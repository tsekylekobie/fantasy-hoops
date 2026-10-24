// Shared contract between the API routes (src/app/api) and the UI.
// Change it only together with both sides.

export type StatMode = "avg" | "total";

/** Position filter values for GET /api/players?pos=. "all" means no filter. */
export type PositionFilter = "all" | "G" | "F" | "C";

/**
 * The nine categories plus the makes/attempts behind the percentages.
 * Per-game averages or season totals, depending on the request's mode.
 * fgPct/ftPct are summed makes / summed attempts (null when attempts are 0).
 */
export interface CategoryLine {
  fgm: number;
  fga: number;
  fgPct: number | null;
  ftm: number;
  fta: number;
  ftPct: number | null;
  fg3m: number;
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
}

export interface PlayerSummary {
  id: number;
  firstName: string;
  lastName: string;
  teamAbbr: string | null;
  position: string | null;
  /** NBA person id for headshots; null until the mapping script has run. */
  nbaPersonId: number | null;
}

export interface PlayerRow extends PlayerSummary {
  /** 1-based rank by 9CAT value across all players matching the filters. */
  rank: number;
  gp: number;
  /** Minutes per game in avg mode, total minutes in total mode. */
  min: number;
  stats: CategoryLine;
  /** 9CAT value (sum of category z-scores; higher is better). */
  value: number;
}

/**
 * GET /api/players?season=2026&mode=avg&q=&pos=all&page=1&perPage=50
 * Sorted by value descending.
 */
export interface PlayersResponse {
  season: number;
  mode: StatMode;
  page: number;
  perPage: number;
  total: number;
  players: PlayerRow[];
}

export interface GameLogRow {
  gameId: number;
  /** ISO date, yyyy-mm-dd. */
  date: string;
  opponentAbbr: string;
  home: boolean;
  result: "W" | "L" | null;
  min: number;
  fgm: number;
  fga: number;
  ftm: number;
  fta: number;
  fg3m: number;
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
}

/** Per-game averages for one season. */
export interface SeasonRow extends CategoryLine {
  season: number;
  gp: number;
  min: number;
}

/** GET /api/players/:id?season=2026 */
export interface PlayerDetailResponse {
  player: PlayerSummary & {
    teamName: string | null;
    /** No injury data in M1, so this is null and the UI hides the chip. */
    availability: "available" | "day-to-day" | "out" | null;
  };
  season: number;
  /** Per-game averages for `season`; null if the player has no games in it. */
  seasonAverages: SeasonRow | null;
  /** Newest game first. */
  gameLog: GameLogRow[];
  /** Seasons before `season`, newest first. */
  pastSeasons: SeasonRow[];
}

export const CURRENT_SEASON = 2026;

/** 2026 -> "2026–27" */
export function seasonLabel(season: number): string {
  return `${season}–${String((season + 1) % 100).padStart(2, "0")}`;
}

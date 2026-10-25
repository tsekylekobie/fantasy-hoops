// Shared contract between the API routes (src/app/api) and the UI.
// Change it only together with both sides.

export type StatMode = "avg" | "total";

/** Columns GET /api/players can sort by. "value" is the 9CAT value (the default). */
export const SORT_KEYS = [
  "value", "name", "gp", "min", "fgPct", "ftPct", "fg3m", "pts", "reb", "ast", "stl", "blk", "tov",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

/** Direction a column sorts in when first clicked: best first (fewest turnovers, A–Z names). */
export function defaultSortDir(key: SortKey): SortDir {
  return key === "tov" || key === "name" ? "asc" : "desc";
}

/** Which games count: the whole season, or the 14 days ending at the season's latest game (or today). */
export type StatRange = "season" | "last14";

/** Which players GET /api/players?scope= lists: free agents (on no team in the season's league) or everyone. */
export type PlayerScope = "fa" | "all";

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
  /** 1-based rank by 9CAT value among all players with a game this season (independent of q/pos). */
  rank: number;
  gp: number;
  /** Minutes per game in avg mode, total minutes in total mode. */
  min: number;
  stats: CategoryLine;
  /** 9CAT value (sum of category z-scores; higher is better). */
  value: number;
}

/**
 * GET /api/players?season=2026&range=season&mode=avg&sort=value&dir=desc&scope=all&q=&pos=all&page=1&perPage=50
 * GP, stats, value and rank all cover `range`; rank counts rostered players even when scope=fa. Sorting uses the `mode`'s numbers;
 * players with no attempts sort last for FG%/FT%; ties go to the better 9CAT rank.
 */
export interface PlayersResponse {
  season: number;
  range: StatRange;
  sort: SortKey;
  dir: SortDir;
  /** Inclusive ISO dates (yyyy-mm-dd) of the last-14-days window; null for the whole season. */
  from: string | null;
  to: string | null;
  mode: StatMode;
  scope: PlayerScope;
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

// Matchup (/matchup)

/** The nine scored categories, in display order. */
export const CATEGORY_KEYS = ["fgPct", "ftPct", "fg3m", "pts", "reb", "ast", "stl", "blk", "tov"] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];

/** A category's outcome for one side. */
export type CategoryResult = "win" | "loss" | "tie";

/** Categories won, lost and tied. */
export interface MatchupScore {
  wins: number;
  losses: number;
  ties: number;
}

export interface FantasyTeamSummary {
  id: number;
  name: string;
  abbreviation: string;
}

export interface MatchupSide extends FantasyTeamSummary {
  /** Week totals from starters' games (FG%/FT% = summed makes / summed attempts). */
  stats: CategoryLine;
  /** Starter games played so far this week. */
  gamesPlayed: number;
  /** Starter games still to tip off this week (current lineup and NBA teams). */
  gamesLeft: number;
}

export interface Matchup {
  /** The signed-in manager's team. */
  team: MatchupSide;
  opponent: MatchupSide;
  /** Outcome of each category for `team`. */
  results: Record<CategoryKey, CategoryResult>;
  score: MatchupScore;
}

/** Another pairing this week, scored for teamA. teamB null = playoff bye. */
export interface OtherMatchup {
  teamA: FantasyTeamSummary;
  teamB: FantasyTeamSummary | null;
  score: MatchupScore;
}

/** The /matchup page: one league week from the signed-in manager's side. */
export interface MatchupWeek {
  season: number;
  week: number;
  weekCount: number;
  /** Inclusive ISO dates (yyyy-mm-dd). */
  startsOn: string;
  endsOn: string;
  isPlayoffs: boolean;
  status: "upcoming" | "live" | "final";
  /** 1-based day of the week while live, else null. */
  day: number | null;
  days: number;
  /** null when signed out, without a team, or the team has no game (bye). */
  matchup: Matchup | null;
  /** The manager's team, when signed in and in the league. */
  myTeam: FantasyTeamSummary | null;
  /** The manager's starters whose NBA team doesn't play today (live weeks only). */
  idleStarters: PlayerSummary[];
  /** Every other pairing this week. */
  others: OtherMatchup[];
}

/** The signed-in user, as the UI sees it. */
export interface SessionUser {
  id: number;
  email: string;
  name: string;
  pictureUrl: string | null;
}

/** GET /api/auth/session */
export interface SessionResponse {
  user: SessionUser | null;
  /** True when sign-in goes to the local mock page instead of Google. */
  mock: boolean;
}

// Team lineup (/my-team)

/** Lineup slots, in display order. BN, IL and IL+ don't score. */
export const LINEUP_SLOTS = ["PG", "SG", "G", "SF", "PF", "F", "C", "UTIL", "BN", "IL", "IL+"] as const;
export type LineupSlot = (typeof LINEUP_SLOTS)[number];
export const STARTING_SLOTS: readonly LineupSlot[] = ["PG", "SG", "G", "SF", "PF", "F", "C", "UTIL"];

/** A player's NBA game on the lineup's date, from his team's point of view. */
export interface LineupGame {
  opponentAbbr: string;
  home: boolean;
  /** Tip-off as an ISO timestamp; null if the schedule has no time. */
  tipoff: string | null;
  state: "scheduled" | "live" | "final";
  /** Provider status for live games, e.g. "2nd Qtr"; null otherwise. */
  statusText: string | null;
  teamScore: number | null;
  opponentScore: number | null;
}

/**
 * Why a player can't be moved: the date is past, his game has tipped off, or
 * (leagues that lock by day) the day's first game has tipped off.
 */
export type LineupLock = "past" | "game" | "day";

export interface LineupPlayer extends PlayerSummary {
  slot: LineupSlot;
  /** Slots he may hold on this date: position slots, UTIL, BN, and IL/IL+ if his injury status allows. */
  eligible: LineupSlot[];
  lock: LineupLock | null;
  /** Latest injury report status ("Out", "Day-To-Day", ...); null when healthy. */
  injuryStatus: string | null;
  game: LineupGame | null;
  /** His NBA team's games in the lineup's week (see `days`): not yet tipped off, and in all. */
  weekGames: { remaining: number; total: number };
  /**
   * His stat line for this date's game (live games update as the sync runs).
   * Null when he has no game or no stat row yet; min 0 means he didn't play.
   */
  dayStats: (CategoryLine & { min: number }) | null;
}

/** GET /api/team/lineup?date=yyyy-mm-dd (default today), the signed-in user's team. */
export interface TeamLineupResponse {
  team: { id: number; name: string; abbreviation: string; waiverPriority: number | null };
  league: {
    id: number;
    name: string;
    season: number;
    lineupLock: "game_time" | "first_game";
    /** Slot counts in display order; slots with 0 are left out. */
    slots: { slot: LineupSlot; count: number }[];
  };
  /** The lineup's date and the league's today (league time zone), yyyy-mm-dd. */
  date: string;
  today: string;
  /** The matchup week containing `date`; null outside the schedule. */
  week: { week: number; startsOn: string; endsOn: string; isPlayoffs: boolean } | null;
  /** Each day of that week (or the Mon–Sun around `date`) with its NBA game count. */
  days: { date: string; nbaGames: number }[];
  players: LineupPlayer[];
}

/** PUT /api/team/lineup: the whole lineup for one day (today or later). Responds with TeamLineupResponse. */
export interface LineupUpdateRequest {
  date: string;
  slots: { playerId: number; slot: LineupSlot }[];
}

/**
 * POST /api/team/lineup/auto: best lineup for `date`, or for every day from
 * `date` (today or later) to the end of its week.
 */
export interface AutoLineupRequest {
  date: string;
  scope: "day" | "week";
}

export interface AutoLineupResponse extends TeamLineupResponse {
  /** Days whose lineup changed, yyyy-mm-dd. */
  changed: string[];
}

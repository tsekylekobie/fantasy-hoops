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
  /** The fantasy team he's on in the season's league; null = free agent. */
  owner: PlayerOwner | null;
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
  /** The fantasy team he's on in the season's league; null = free agent. */
  owner: PlayerOwner | null;
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

/** One row of a matchup roster, for the day shown (or the week). */
export interface MatchupPlayer extends PlayerSummary {
  /** Slot on the day shown; for week totals, on today (clamped to the week). Null: no longer on the roster. */
  slot: LineupSlot | null;
  /** Day view: his NBA game that day. Always null for week totals. */
  game: LineupGame | null;
  /**
   * Day view: his line for that day's game, started or not (null until it has a
   * stat row; min 0 = didn't play). Week totals: summed over the games he
   * started (null if none yet).
   */
  stats: (CategoryLine & { min: number; gp: number }) | null;
}

export interface MatchupSide extends FantasyTeamSummary {
  /** Week totals from starters' games (FG%/FT% = summed makes / summed attempts). */
  stats: CategoryLine;
  /** Starter games played so far this week. */
  gamesPlayed: number;
  /** Starter games still to tip off this week (current lineup and NBA teams). */
  gamesLeft: number;
  /** Slot order (starters, BN, IL, IL+), then players who left the roster. */
  players: MatchupPlayer[];
}

export interface Matchup {
  /** Left side: the signed-in manager's team when it plays in this matchup, else the team asked for. */
  team: MatchupSide;
  opponent: MatchupSide;
  /** Outcome of each category for `team`. */
  results: Record<CategoryKey, CategoryResult>;
  score: MatchupScore;
  /** Whether `team` is the signed-in manager's. */
  isMine: boolean;
}

/** Another pairing this week, scored for teamA. teamB null = playoff bye. */
export interface OtherMatchup {
  teamA: FantasyTeamSummary;
  teamB: FantasyTeamSummary | null;
  score: MatchupScore;
  /** Contains the signed-in manager's team. */
  isMine: boolean;
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
  /** The league's today, yyyy-mm-dd, and its IANA time zone (for tip-off times). */
  today: string;
  timeZone: string;
  /** The league's slot counts in display order; slots with 0 are left out. */
  slots: { slot: LineupSlot; count: number }[];
  /** Whose stats the rosters show: a date in the week, or null for week totals. */
  statsDate: string | null;
  /**
   * The matchup asked for (?team=), else the signed-in manager's. Null when
   * neither applies or that team has a bye.
   */
  matchup: Matchup | null;
  /** The manager's team, when signed in and in the league. */
  myTeam: FantasyTeamSummary | null;
  /** Every pairing this week other than `matchup`. */
  others: OtherMatchup[];
}

// League (/league)

export interface StandingsRow extends FantasyTeamSummary {
  rank: number;
  /** Categories won, lost and tied, summed over every week counted. */
  record: MatchupScore;
  /** (W + T/2) / categories played; null before any. */
  pct: number | null;
  /** Games back of first: half the W and L gaps added together. 0 for the leader. */
  gamesBack: number;
  /** Adds this season (free agents and waiver claims). */
  moves: number;
  isMine: boolean;
}

/** The /league page: standings and this week's scoreboard. */
export interface LeagueOverview {
  season: number;
  name: string;
  teamCount: number;
  playoffTeams: number;
  /** Ranked; ties keep the same rank. */
  standings: StandingsRow[];
  /** Weeks in the standings: finished ones, plus this week's live score while it's being played. */
  weeksCounted: number;
  includesLiveWeek: boolean;
  /** The week containing today (clamped to the season); null with no schedule. */
  week: { week: number; startsOn: string; endsOn: string; isPlayoffs: boolean; status: MatchupWeek["status"] } | null;
  /** That week's pairings, the manager's first. */
  matchups: OtherMatchup[];
  myTeam: FantasyTeamSummary | null;
}

/** transactions.type: every kind of roster move the league records. */
export type TransactionType = "add" | "drop" | "add_drop" | "waiver_claim" | "trade" | "commissioner";

/** One player moved by a transaction. from null = from free agents or waivers; to null = dropped. */
export interface TransactionMove {
  player: PlayerSummary;
  from: FantasyTeamSummary | null;
  to: FantasyTeamSummary | null;
}

/** A completed transaction, for the League page's Recent transactions list. */
export interface LeagueTransaction {
  id: number;
  type: TransactionType;
  /** When rosters changed (processed_at, else created_at), ISO timestamp. */
  at: string;
  /** Who made the move (trades: the proposer). */
  team: FantasyTeamSummary | null;
  /** Trades: the other side. */
  tradeTeam: FantasyTeamSummary | null;
  /** Adds first, then moves between teams, then drops. */
  moves: TransactionMove[];
}

/** The League page's Recent transactions: newest first, and the league's time zone for times. */
export interface RecentTransactions {
  timeZone: string;
  transactions: LeagueTransaction[];
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

// Add / drop (/api/team/transactions)

/** The fantasy team a player is on. */
export interface PlayerOwner {
  teamId: number;
  abbreviation: string;
}

/** Immediate: rosters change now (free agents). Waiver: a pending claim that runs at the league's waiver time. */
export type AddMode = "immediate" | "waiver";

/** One of the manager's players, as the drop list shows him. */
export interface RosterMoveOption extends PlayerSummary {
  /** His slot today. IL and IL+ don't count against the roster limit. */
  slot: LineupSlot;
  injuryStatus: string | null;
  /** Season per-game points and rebounds; null with no games yet. */
  pts: number | null;
  reb: number | null;
  /** 9CAT value this season (last season before he plays); the list is sorted by it, lowest first. */
  value: number;
  /** Why he can't be dropped right now (e.g. locked in today's lineup); null when he can. */
  dropBlocked: string | null;
}

/** The player being added, as the add sheet shows him. */
export interface AddCandidate extends PlayerSummary {
  owner: PlayerOwner | null;
  mode: AddMode;
  /** Season per-game averages; null with no games yet. */
  seasonAverages: CategoryLine | null;
  /** Why he can't be added (rostered, adds limit reached); null when he can. */
  addBlocked: string | null;
}

/**
 * GET /api/team/transactions?add=<playerId>: the signed-in manager's roster
 * and limits, for the add/drop sheet. `add` is filled in when ?add= is given.
 */
export interface RosterMovesContext {
  team: FantasyTeamSummary & { waiverPriority: number | null };
  teamCount: number;
  /** The league's today, yyyy-mm-dd. */
  today: string;
  /** Players counted against the limit (everyone not on IL/IL+ today), and the limit (non-IL slots). */
  rosterCount: number;
  rosterLimit: number;
  /** Adds (free agents and waiver claims) this matchup week and season; null limit = unlimited. */
  addsThisWeek: number;
  maxAddsPerWeek: number | null;
  addsThisSeason: number;
  maxAddsPerSeason: number | null;
  /** Lowest value first. */
  roster: RosterMoveOption[];
  add: AddCandidate | null;
}

/**
 * POST /api/team/transactions: add a free agent, drop a player, or both at
 * once (one DB transaction). At least one id is required; an add that would
 * overfill the roster needs a drop. Responds with RosterMoveResult.
 */
export interface RosterMoveRequest {
  addPlayerId?: number;
  dropPlayerId?: number;
}

export interface RosterMoveResult {
  transactionId: number;
  type: "add" | "drop" | "add_drop" | "waiver_claim";
  /** completed = rosters changed; pending = waiver claim waiting for processAt. */
  status: "completed" | "pending";
  processAt: string | null;
  added: PlayerSummary | null;
  dropped: PlayerSummary | null;
}

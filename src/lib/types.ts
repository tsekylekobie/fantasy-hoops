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

/** Streaming filter GET /api/players?plays=tomorrow,in2: days (league time) the player's NBA team has a scheduled game. */
export const PLAY_DAYS = ["today", "tomorrow", "in2"] as const;
export type PlayDay = (typeof PLAY_DAYS)[number];

/** GET /api/players?waivers=: everyone (any), free agents on waivers (on), or on waivers and clearing by the end of tomorrow (clears). */
export type WaiverFilter = "any" | "on" | "clears";

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

/** The nine categories, in table order. Keys of CategoryWeights and of the ?weights= list. */
export const CATEGORIES = ["fgPct", "ftPct", "fg3m", "pts", "reb", "ast", "stl", "blk", "tov"] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * Punt weights: each category's z-score is multiplied by its weight in the players page's value.
 * 0 ignores (punts) the category, 1 counts it fully; 0 to MAX_WEIGHT.
 */
export type CategoryWeights = Record<Category, number>;
export const MAX_WEIGHT = 2;
/** Turnovers count a quarter by default. Reset goes back to these. */
export const DEFAULT_WEIGHTS: CategoryWeights = {
  fgPct: 1, ftPct: 1, fg3m: 1, pts: 1, reb: 1, ast: 1, stl: 1, blk: 1, tov: 0.25,
};

/** GET /api/me/weights (defaults when signed out or never saved); PUT the same shape to save (signed in). */
export interface WeightsResponse {
  weights: CategoryWeights;
  /** False when signed out: changes apply but aren't saved. */
  signedIn: boolean;
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
  /** 1-based rank by (weighted) 9CAT value among all players with a game this season (independent of q/pos). */
  rank: number;
  gp: number;
  /** Minutes per game in avg mode, total minutes in total mode. */
  min: number;
  stats: CategoryLine;
  /** 9CAT value (sum of category z-scores times the request's weights; higher is better). */
  value: number;
  /** The fantasy team he's on in the season's league; null = free agent. */
  owner: PlayerOwner | null;
  /** Set when he's a free agent on waivers: adding him is a claim. */
  waiver: PlayerWaiver | null;
  /** His team's scheduled games on the requested `plays` days, in date order; empty without `plays`. */
  games: PlayerUpcomingGame[];
}

/** A scheduled (not started, not postponed) NBA game, for the streaming filter. */
export interface PlayerUpcomingGame {
  /** Which requested day it falls on. */
  day: PlayDay;
  /** ISO date, yyyy-mm-dd (the league-time day). */
  date: string;
  opponentAbbr: string;
  home: boolean;
  /** Tip-off, ISO UTC; null when the time is not set yet. */
  tipoff: string | null;
}

/**
 * GET /api/players?season=2026&range=season&mode=avg&sort=value&dir=desc&scope=all&q=&pos=all&plays=&waivers=any&page=1&perPage=50
 *   &weights=1,1,1,1,1,1,1,1,0.25  (one per CATEGORIES entry, in order; omitted = DEFAULT_WEIGHTS)
 * GP, stats, value and rank all cover `range`; value and rank use `weights`; rank counts rostered players even when scope=fa. Sorting uses the `mode`'s numbers;
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
  /** Days filtered on (empty = any day), and the league-time date each stands for. */
  plays: PlayDay[];
  playDates: Record<PlayDay, string>;
  waivers: WaiverFilter;
  weights: CategoryWeights;
  page: number;
  perPage: number;
  total: number;
  players: PlayerRow[];
  /** The league's time zone, for showing each player's `waiver.clearsAt`. */
  timeZone: string;
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
  /** Set when he's a free agent on waivers: adding him is a claim. */
  waiver: PlayerWaiver | null;
  /** The league's time zone, for showing `waiver.clearsAt`. */
  timeZone: string;
  season: number;
  /** Per-game averages for `season`; null if the player has no games in it. */
  seasonAverages: SeasonRow | null;
  /** Newest game first. */
  gameLog: GameLogRow[];
  /** Seasons before `season`, newest first. */
  pastSeasons: SeasonRow[];
  /** His games in the league's current matchup week; null outside the schedule. */
  thisWeek: PlayerWeek | null;
}

/** A player's NBA games in one matchup week. */
export interface PlayerWeek {
  week: number;
  /** Inclusive ISO dates (yyyy-mm-dd). */
  startsOn: string;
  endsOn: string;
  isPlayoffs: boolean;
  /** The league's IANA time zone, for tip-off times. */
  timeZone: string;
  /** In tip-off order. A game is done once it's tipped off (state live or final). */
  games: (LineupGame & { gameId: number; date: string })[];
  /** Games not yet tipped off, and in all: the same counts as LineupPlayer.weekGames. */
  remaining: number;
  total: number;
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
  /** /api/teams/<id>/logo?v=<version>; null when the team has no logo (show the abbreviation). */
  logoUrl: string | null;
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
  /** The owner's name; null for an unowned team. */
  managerName: string | null;
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
  /** Set for playoff and toilet bowl matchups (absent in the regular season). */
  bracket?: BracketTag;
}

/** Another pairing this week, scored for teamA. teamB null = playoff bye. */
export interface OtherMatchup {
  teamA: FantasyTeamSummary;
  teamB: FantasyTeamSummary | null;
  score: MatchupScore;
  /** Contains the signed-in manager's team. */
  isMine: boolean;
  /** Set for playoff and toilet bowl matchups (absent in the regular season). */
  bracket?: BracketTag;
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
  /** Bottom teams in the toilet bowl; 0 when it's off. */
  toiletBowlTeams?: number;
  /** The Standings card's Playoffs view. */
  playoffs?: PlayoffsView;
}

// Playoffs and the toilet bowl (src/lib/playoffs/bracket.ts)

/**
 * "playoffs": the winner advances, the final's winner is champion.
 * "toilet_bowl": the loser advances, the final's loser is last place.
 */
export type BracketKind = "playoffs" | "toilet_bowl";

/** Which bracket game a matchup is, e.g. "Playoffs · Semifinal" or "Toilet bowl · Round 1". */
export interface BracketTag {
  kind: BracketKind;
  round: number;
  /** "Quarterfinal", "Semifinal", "Final", "Round 1", ... */
  roundName: string;
  /** "Playoffs · Semifinal" */
  label: string;
}

export interface BracketTeam extends FantasyTeamSummary {
  /** Final (or, projected, current) regular-season seed: 1 = first place. */
  seed: number;
  /** Regular-season category record. */
  record: MatchupScore;
  isMine: boolean;
}

/** One bracket game. a/b null = not decided yet (TBD); b null with bye = a bye. */
export interface BracketGame {
  slot: number;
  a: BracketTeam | null;
  b: BracketTeam | null;
  bye: boolean;
  /** Categories for `a`, once the week has started; null before (and for byes). */
  score: MatchupScore | null;
  status: "upcoming" | "live" | "final";
  /** Final games: who won (a tie goes to the better seed). */
  winnerId: number | null;
  /** Who moves on: the winner in the playoffs, the loser in the toilet bowl, the team with a bye. */
  advancesId: number | null;
}

export interface BracketRound {
  round: number;
  name: string;
  /** The league week this round is played in; null without a playoff schedule. */
  week: { week: number; startsOn: string; endsOn: string } | null;
  games: BracketGame[];
}

export interface Bracket {
  kind: BracketKind;
  teams: number;
  rounds: BracketRound[];
  /** Champion (playoffs) or last place (toilet bowl), once the final is final. */
  result: BracketTeam | null;
}

/**
 * The League page's Playoffs view. projected: seeded from today's standings
 * ("if the season ended today"); otherwise the real bracket, from matchups.
 */
export interface PlayoffsView {
  projected: boolean;
  playoffs: Bracket;
  /** Null when the league has no toilet bowl. */
  toiletBowl: Bracket | null;
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
  /**
   * Slots he may hold on this date: position slots, UTIL, BN, and IL/IL+ if
   * the league's IL rule allows (rules.ilEligibility). A player on IL whose
   * slot isn't listed here no longer qualifies.
   */
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
  /** managerName: the owner's name; null for an unowned team. */
  team: FantasyTeamSummary & { managerName: string | null; waiverPriority: number | null };
  league: {
    id: number;
    name: string;
    season: number;
    lineupLock: "game_time" | "first_game";
    /** Slot counts in display order; slots with 0 are left out. */
    slots: { slot: LineupSlot; count: number }[];
    /** Who may use each IL slot the league has, e.g. "Out, 3+ days on the injury report". */
    ilRules: { slot: LineupSlot; text: string }[];
  };
  /**
   * Why the roster is illegal on this date: a player on IL who no longer
   * qualifies, or too many active players. Empty when legal (and for past
   * days). While illegal the team can't add players or place claims.
   */
  rosterProblems: string[];
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

/** A free agent on waivers: adding him is a claim that processes at `clearsAt`. */
export interface PlayerWaiver {
  /** The waiver run that decides his claims (and after which he's a free agent), ISO UTC. */
  clearsAt: string;
  /** dropped: recently dropped (leagues.waiver_days); game_started: his game today has tipped off (waivers_after_game_start). */
  reason: "dropped" | "game_started";
  droppedBy: FantasyTeamSummary | null;
}

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
  /** The roster is illegal and dropping him (with an add) would make it legal and leave room. */
  fixesIllegalRoster: boolean;
}

/** The player being added, as the add sheet shows him. */
export interface AddCandidate extends PlayerSummary {
  owner: PlayerOwner | null;
  mode: AddMode;
  /** Set when mode is "waiver". */
  waiver: PlayerWaiver | null;
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
  /** The league's time zone, for showing waiver times. */
  timeZone: string;
  /** Whether a dropped player goes on waivers, and for how many days. */
  dropsToWaivers: boolean;
  waiverDays: number;
  /** Players counted against the limit (everyone not on IL/IL+ today), and the limit (non-IL slots). */
  rosterCount: number;
  rosterLimit: number;
  /**
   * Why the roster is illegal today (see TeamLineupResponse.rosterProblems).
   * While it's non-empty, adds are refused unless the drop fixes it.
   */
  rosterProblems: string[];
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

// Trades (/team/[id]/trade, and the trades panels on /my-team and /league)

/**
 * Where a trade stands. `offered`: waiting on the other manager. `review`:
 * accepted, in the league's review window (the rest of the league can vote
 * to veto, or the commissioner can, depending on the league). The rest are final.
 */
export type TradeStatus = "offered" | "review" | "completed" | "rejected" | "cancelled" | "vetoed" | "failed";

/** How the league reviews accepted trades (leagues.trade_review). */
export type TradeReview = "none" | "commissioner" | "league_vote";

export interface TradeSettings {
  review: TradeReview;
  /** Length of the review window. */
  reviewDays: number;
  /** Veto votes that kill a trade (league_vote only). */
  vetoVotes: number;
  /** Last day trades can be proposed or accepted (yyyy-mm-dd); null = none. */
  deadline: string | null;
  /** Most players a team may carry outside IL/IL+ (the league's non-IL slots). */
  activeLimit: number;
}

export interface Trade {
  id: number;
  status: TradeStatus;
  /** The team that proposed it, and the team it was offered to. */
  proposer: FantasyTeamSummary;
  partner: FantasyTeamSummary;
  /** Players going from the proposer to the partner, and back. */
  sends: PlayerSummary[];
  receives: PlayerSummary[];
  note: string | null;
  /** ISO timestamps. */
  createdAt: string;
  acceptedAt: string | null;
  /** When the review window ends (it processes then, or as soon as its players unlock). */
  processAt: string | null;
  /** When it completed, or was rejected, cancelled, vetoed or failed. */
  closedAt: string | null;
  /** Why it failed or who vetoed it; null otherwise. */
  reason: string | null;
  vetoVotes: number;
  /** The signed-in manager's relation to it. */
  role: "proposer" | "partner" | "league" | null;
  myVote: boolean;
  can: { accept: boolean; reject: boolean; cancel: boolean; vote: boolean; veto: boolean };
}

/** GET /api/trades: open trades (offered or in review) and the latest closed ones. Due trades process first. */
export interface TradesResponse {
  settings: TradeSettings;
  myTeam: FantasyTeamSummary | null;
  isCommissioner: boolean;
  open: Trade[];
  /** Newest first, up to 10. */
  recent: Trade[];
}

/** A rostered player as the trade builder shows him. */
export interface TradeRosterPlayer extends PlayerSummary {
  slot: LineupSlot;
  injuryStatus: string | null;
  /** Season per-game line and 9CAT value; null before his first game. */
  gp: number;
  stats: CategoryLine | null;
  value: number | null;
  /** In another open trade (it would fail if that one processes first). */
  inOpenTrade: boolean;
}

/** GET /api/trades/builder?team=ID: both rosters for a trade with team ID. */
export interface TradeBuilderResponse {
  settings: TradeSettings;
  myTeam: FantasyTeamSummary & { players: TradeRosterPlayer[] };
  partner: FantasyTeamSummary & { players: TradeRosterPlayer[] };
  /** The league's today, yyyy-mm-dd. */
  today: string;
}

/** POST /api/trades: propose. Responds with the new Trade. */
export interface TradeProposal {
  partnerTeamId: number;
  /** From the proposer's roster. */
  sendPlayerIds: number[];
  /** From the partner's roster. */
  receivePlayerIds: number[];
  note?: string;
}

/**
 * POST /api/trades/:id { action }. accept/reject: the partner. cancel: the
 * proposer, before it processes. vote/unvote: other teams, during league-vote
 * review. veto: the commissioner, during review. Responds with the Trade.
 */
export type TradeAction = "accept" | "reject" | "cancel" | "vote" | "unvote" | "veto";

// Waivers (/api/team/claims, the League page's waiver order)

/** One of the manager's waiver claims. */
export interface WaiverClaim {
  id: number;
  status: "pending" | "completed" | "failed" | "cancelled";
  /** The team's preference order among its pending claims, 1 = first; null once processed. */
  rank: number | null;
  add: PlayerSummary;
  drop: PlayerSummary | null;
  /** ISO UTC: when it processes (pending) or processed. */
  processAt: string;
  processedAt: string | null;
  failureReason: string | null;
  createdAt: string;
}

/**
 * GET /api/team/claims: the signed-in manager's pending claims in rank order,
 * and claims processed in the last 7 days, newest first.
 */
export interface MyClaimsResponse {
  timeZone: string;
  /** Local run time, "HH:MM". */
  waiverTime: string;
  /** ISO weekdays waivers run on (1 = Mon ... 7 = Sun). */
  waiverDaysOfWeek: number[];
  nextRunAt: string;
  waiverPriority: number | null;
  teamCount: number;
  pending: WaiverClaim[];
  recent: WaiverClaim[];
}

/** PUT /api/team/claims { order: claimIds } reorders all pending claims (responds MyClaimsResponse). DELETE /api/team/claims/:id cancels one. */
export interface ClaimOrderRequest {
  order: number[];
}

/** The League page's waiver order and settings. */
export interface WaiverOrder {
  type: "continual_rolling" | "reverse_standings" | "faab";
  timeZone: string;
  waiverTime: string;
  /** ISO weekdays waivers run on (1 = Mon ... 7 = Sun). */
  waiverDaysOfWeek: number[];
  waiverDays: number;
  waiversAfterGameStart: boolean;
  nextRunAt: string;
  /** First claim first. */
  teams: (FantasyTeamSummary & { priority: number; pendingClaims: number })[];
}

// --- League settings (commissioner only) ---

/** Injury report statuses (player_injuries.status) the IL rules can name. */
export const INJURY_STATUSES = ["Out", "Doubtful", "Questionable", "Day-To-Day", "Probable"] as const;

/**
 * The rules on the leagues row the commissioner can change. GET /api/league/settings
 * responds LeagueSettingsResponse; PUT takes a whole LeagueSettings and responds the same.
 * Changes apply from now on: past lineups and processed transactions are untouched,
 * and pending claims and waivers move to the next run on the new schedule.
 */
export interface LeagueSettings {
  waiverType: WaiverOrder["type"];
  /** Local run time, "HH:MM". */
  waiverTime: string;
  /** IANA zone the run time and the league's days are in. */
  timeZone: string;
  /** ISO weekdays waivers run on (1 = Mon ... 7 = Sun), ascending, at least one. */
  waiverDaysOfWeek: number[];
  /** Days a dropped player stays on waivers; 0 = straight to free agents. */
  waiverDays: number;
  waiversAfterGameStart: boolean;
  /** Count of IL and IL+ slots (leagues.roster_slots). */
  ilSlots: number;
  ilStatuses: string[];
  ilMinDays: number;
  ilPlusSlots: number;
  ilPlusStatuses: string[];
  ilPlusMinDays: number;
  tradeReview: TradeReview;
  tradeReviewDays: number;
  tradeVetoVotes: number;
  /** Last day trades can be proposed, yyyy-mm-dd; null = none. */
  tradeDeadline: string | null;
  /** null = unlimited. */
  maxAddsPerWeek: number | null;
  maxAddsPerSeason: number | null;
  /** Teams in the playoff bracket (top seeds; byes when not a power of two). */
  playoffTeams: number;
  /** First playoff week (league_weeks.week); one week per round. */
  playoffStartWeek: number;
  /** Bottom teams play a loser-advances bracket; its final's loser is last place. */
  toiletBowl: boolean;
  toiletBowlTeams: number;
}

export interface LeagueSettingsResponse {
  leagueName: string;
  teamCount: number;
  settings: LeagueSettings;
  /** The next waiver run on the saved schedule. */
  nextRunAt: string;
  updatedAt: string;
  /** The league's schedule, for the playoff start week. */
  weeks?: { week: number; startsOn: string; endsOn: string }[];
  /** Playoff matchups exist: the playoff settings can't change any more. */
  playoffsStarted?: boolean;
}

// Team profile (/api/team/profile)

/** Limits on a team's name and abbreviation; the server enforces them, the Edit team form mirrors them. */
export const TEAM_NAME_LENGTH = { min: 2, max: 32 } as const;
/** 2–4 uppercase letters or digits, at least one letter. */
export const TEAM_ABBREVIATION = /^(?=.*[A-Z])[A-Z0-9]{2,4}$/;
/** Logo uploads: PNG, JPEG or WebP, up to 1 MB (the form uploads a ~256px square). */
export const TEAM_LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const TEAM_LOGO_MAX_BYTES = 1024 * 1024;

/**
 * PATCH /api/team/profile: rename a team or change its abbreviation. `teamId`
 * defaults to your own team; the commissioner may name any team in the league.
 * Responds with the updated FantasyTeamSummary.
 *
 * PUT /api/team/profile/logo?team=<id>  body: the image bytes, Content-Type its type.
 * DELETE /api/team/profile/logo?team=<id>  removes it. Both respond with the FantasyTeamSummary.
 */
export interface TeamProfileUpdate {
  teamId?: number;
  name?: string;
  abbreviation?: string;
}

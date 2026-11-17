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

/** Which games count: the whole season, or the 30 or 14 days ending at the season's latest game (or today). */
export type StatRange = "season" | "last30" | "last14";
export const STAT_RANGES: readonly StatRange[] = ["season", "last30", "last14"];
/** The Players page's range: a preset, or `custom` dates (`from`/`to` in the query). */
export type PlayersRange = StatRange | "custom";

/**
 * Which players GET /api/players?scope= lists: free agents (on no team in the season's league), everyone, or the
 * signed-in user's watchlist, rostered or not (401 signed out).
 */
export type PlayerScope = "fa" | "all" | "watch";

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
 * Punts, stored as weights: 0 punts the category, anything above 0 counts it at its DURANT H2H weight (value.ts).
 * The players page sets 0 or 1 (punt toggles); older saved weights (up to MAX_WEIGHT) read the same way.
 * TO is never counted (DURANT H2H excludes it) and has no toggle; its stored weight is ignored.
 */
export type CategoryWeights = Record<Category, number>;
export const MAX_WEIGHT = 2;
/** Nothing punted. TO's 0.3 is left from the old sliders and means nothing now. Reset goes back to these. */
export const DEFAULT_WEIGHTS: CategoryWeights = {
  fgPct: 1, ftPct: 1, fg3m: 1, pts: 1, reb: 1, ast: 1, stl: 1, blk: 1, tov: 0.3,
};

/**
 * How the Players page values and ranks players: "durant" (Josh Lloyd's DURANT H2H: transformed categories,
 * no TO, worst category dropped) or "9cat" (the plain average of the nine z-scores, TO included).
 */
export const RANK_METHODS = ["durant", "9cat"] as const;
export type RankMethod = (typeof RANK_METHODS)[number];

/** The categories that can be punted: all but TO. */
export const PUNTABLE_CATEGORIES = CATEGORIES.filter((c) => c !== "tov");

/** The punted categories (weight 0), TO aside, in table order. */
export function puntedCategories(w: CategoryWeights): Category[] {
  return PUNTABLE_CATEGORIES.filter((c) => w[c] === 0);
}

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

/** A player's current injury report entry. */
export interface PlayerInjury {
  /** "Out", "Doubtful", "Questionable", "Day-To-Day", "Probable" (INJURY_STATUSES). */
  status: string;
  /** The provider's estimated return, yyyy-mm-dd; null when unknown. */
  returnDate: string | null;
  /** "Left Calf Strain", "Knee", "Not With Team", ...; null when the report doesn't say. */
  injury: string | null;
  /** The latest news blurb. */
  note: string | null;
}

export interface PlayerRow extends PlayerSummary {
  /**
   * 1-based rank by (weighted) 9CAT `value` among all players with a game in the range (independent of q/pos).
   * Null for a player with no game in the range, listed only by a name search (`gp` 0, no value or tiers).
   */
  rank: number | null;
  gp: number;
  /** Minutes per game in avg mode, total minutes in total mode. */
  min: number;
  stats: CategoryLine;
  /**
   * 9CAT value (average of category z-scores weighted by the request's weights; 0 = average rosterable player, higher
   * is better): of per-game averages in avg mode, of the range's totals in total mode (fewer games, lower value).
   */
  value: number | null;
  /**
   * Shading for each stat cell and Value: where he falls among the valuation pool, the ~156 players worth rostering
   * (same scale as Box scores). Per game (category z-scores) in avg mode; season totals in total mode (FG%/FT%: total
   * impact), so fewer games ranks lower; Value's tier follows its number. No FG%/FT% tier without attempts.
   */
  tiers: Partial<Record<Category | "value", RankTier>>;
  /** The fantasy team he's on in the season's league; null = free agent. */
  owner: PlayerOwner | null;
  /** Set when he's a free agent on waivers: adding him is a claim. */
  waiver: PlayerWaiver | null;
  /** His team's scheduled games on the requested `plays` days, in date order; empty without `plays`. */
  games: PlayerUpcomingGame[];
  /** His NBA games in the league's current matchup week, as on My team (LineupPlayer.weekGames); null outside the schedule. */
  weekGames: { remaining: number; total: number } | null;
  /** Null when healthy. */
  injury: PlayerInjury | null;
  /** On the signed-in user's watchlist; null when signed out (no star). */
  watched: boolean | null;
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
 *   &weights=1,1,1,1,1,1,1,1,0.3  (one per CATEGORIES entry, in order; omitted = DEFAULT_WEIGHTS)
 *   &method=durant|9cat  (how value and rank are computed; omitted = durant)
 *   range=custom takes &from=yyyy-mm-dd&to=yyyy-mm-dd (inclusive, both required, from <= to).
 * GP, stats, value and rank all cover `range`; value and rank use `weights`; rank counts rostered players even when scope=fa. Sorting uses the `mode`'s numbers;
 * players with no attempts sort last for FG%/FT%; ties go to the better 9CAT rank.
 */
/** One choice in a Players team filter: a fantasy team (fantasy_teams.id) or an NBA team (teams.id). */
export interface PlayersTeamOption {
  id: number;
  abbreviation: string;
  name: string;
}

export interface PlayersResponse {
  season: number;
  range: PlayersRange;
  sort: SortKey;
  dir: SortDir;
  /** Inclusive ISO dates (yyyy-mm-dd) of the last-30, last-14 or custom window; null for the whole season. */
  from: string | null;
  to: string | null;
  /** The season's first and last dates with a played game (the custom range picker's bounds); null before any. */
  firstDate: string | null;
  lastDate: string | null;
  mode: StatMode;
  scope: PlayerScope;
  /** Days filtered on (empty = any day), and the league-time date each stands for. */
  plays: PlayDay[];
  playDates: Record<PlayDay, string>;
  waivers: WaiverFilter;
  /** Players listed Out are left out (`injured=hide`). */
  hideInjured: boolean;
  /** Fantasy team filtered on (fantasy_teams.id), or null. */
  team: number | null;
  /** NBA team filtered on (abbreviation), or null. */
  nba: string | null;
  /** Choices for the team filters: the season league's fantasy teams and the NBA's, by name. */
  teamOptions: { fantasy: PlayersTeamOption[]; nba: PlayersTeamOption[] };
  weights: CategoryWeights;
  method: RankMethod;
  page: number;
  perPage: number;
  total: number;
  players: PlayerRow[];
  /** The league's time zone, for showing each player's `waiver.clearsAt`. */
  timeZone: string;
  /** The signed-in viewer's team in the league (their players get a dark chip); null signed out or without one. */
  myTeamId: number | null;
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

/** A finished season's averages, with his 9CAT rank that season. */
export interface PastSeasonRow extends SeasonRow {
  /** Rank among every player with a game that season, at DEFAULT_WEIGHTS (not your punt weights); null if unranked. */
  rank: number | null;
}

/** One fantasy news update (ESPN / Rotowire). */
export interface PlayerNewsItem {
  id: string;
  /** The update itself, e.g. "Williams has been ruled out for Saturday's game." */
  headline: string;
  /** The analysis under it; null when there is none. */
  story: string | null;
  /** ISO timestamp. */
  published: string;
}

/** GET /api/players/:id/news. Fetched live, so it can be empty when the source is down. */
export interface PlayerNewsResponse {
  items: PlayerNewsItem[];
}

/** GET /api/players/:id?season=2026 */
export interface PlayerDetailResponse {
  player: PlayerSummary & {
    teamName: string | null;
    /** Null when healthy. */
    injury: PlayerInjury | null;
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
  /** His rank for `season` and its last 30 and 14 days, as the Players page ranks them (your punts), by `method`. */
  ranks: PlayerRanks;
  /** The same ranks by the other method (9CAT when `method` is DURANT, and the other way round). */
  otherRanks: PlayerRanks;
  /** Newest game first. */
  gameLog: GameLogRow[];
  /** Seasons before `season`, newest first. */
  pastSeasons: PastSeasonRow[];
  /** His games in the league's current matchup week; null outside the schedule. */
  thisWeek: PlayerWeek | null;
  /** Every completed move of his in the season's league, newest first. */
  transactions: PlayerTransaction[];
  /** On the signed-in user's watchlist; null when signed out (no star). */
  watched: boolean | null;
}

/** PUT (watch) or DELETE (unwatch) /api/players/:id/watch; 401 signed out, 404 no such player. */
export interface WatchResponse {
  playerId: number;
  watched: boolean;
}

/** One completed move of a player (an add, drop, claim, trade or commissioner move), for the player modal. */
export interface PlayerTransaction {
  id: number;
  type: TransactionType;
  /** When rosters changed (processed_at, else created_at), ISO timestamp. */
  at: string;
  /** The team he left; null = came from free agents or waivers. */
  from: FantasyTeamSummary | null;
  /** The team he joined; null = dropped. */
  to: FantasyTeamSummary | null;
  /** A waiver claim won in a FAAB league: what it cost, in whole dollars. Null otherwise. */
  faabBid: number | null;
}

/** 1-based 9CAT ranks over each StatRange; null when he has no games in it. */
export type PlayerRanks = Record<StatRange, number | null>;

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
  /**
   * Week totals only (null in the day view): his projected week, `stats` plus
   * his starts still to tip off that will count, at his recent average (see
   * MatchupSide.projected), in whole numbers; gp counts both. Null when neither.
   */
  projected: (CategoryLine & { gp: number }) | null;
  /** His current injury report entry (not as of the day shown); null when not on the report. */
  injury: PlayerInjury | null;
}

export interface MatchupSide extends FantasyTeamSummary {
  /** The owner's name; null for an unowned team. */
  managerName: string | null;
  /** Week totals from starters' games (FG%/FT% = summed makes / summed attempts). */
  stats: CategoryLine;
  /**
   * Projected week totals: `stats` plus one game at the player's per-game average
   * (last 30 days with 5+ games, else season) for every start still to tip off
   * that will count, on the lineups as set (benched days add nothing). Players
   * listed Out add nothing until their estimated return. Whole numbers; FG%/FT%
   * from the projected makes / attempts.
   */
  projected: CategoryLine;
  /** Starter games played so far this week (that counted, under game limits). */
  gamesPlayed: number;
  /** Starter games still to tip off this week (current lineup and NBA teams) that will count under game limits. */
  gamesLeft: number;
  /** The week's game limit total, when the week has game limits. */
  gameLimit?: number;
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
  /** The same for the sides' `projected` lines. */
  projectedResults: Record<CategoryKey, CategoryResult>;
  projectedScore: MatchupScore;
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
  /** The matchup page only: the score of the teams' projected week totals (MatchupSide.projected). */
  projectedScore?: MatchupScore;
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
  /** The page shows projected week totals (?view=projected); statsDate is then null. */
  projected: boolean;
  /**
   * The matchup asked for (?team=), else the signed-in manager's. Null when
   * neither applies or that team has a bye.
   */
  matchup: Matchup | null;
  /** The manager's team, when signed in and in the league. */
  myTeam: FantasyTeamSummary | null;
  /** Every pairing this week other than `matchup`. */
  others: OtherMatchup[];
  /** A game with a player on one of the league's rosters is in progress: the page polls while true. */
  live: boolean;
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
  /** Weeks in the standings: finished regular-season weeks only (not this week's live score). */
  weeksCounted: number;
  /** The scoreboard's week: the one asked for (?week=N), else `currentWeek`; null with no schedule. */
  week: { week: number; startsOn: string; endsOn: string; isPlayoffs: boolean; status: MatchupWeek["status"] } | null;
  /** The week containing today (clamped to the season); null with no schedule. */
  currentWeek: number | null;
  weekCount: number;
  /** That week's pairings, the manager's first. Empty for a playoff week not paired yet. */
  matchups: OtherMatchup[];
  myTeam: FantasyTeamSummary | null;
  /** Bottom teams in the toilet bowl; 0 when it's off. */
  toiletBowlTeams?: number;
  /** The Standings card's Playoffs view. */
  playoffs?: PlayoffsView;
}

// Power rankings (/rankings)

/** One week on its own, or every regular-season week played added together. */
export type RankingsPeriod = "week" | "season";

/** A team in the stack rank. */
export interface RankingsRow extends FantasyTeamSummary {
  /** 1 = best all-play record; ties keep the same rank. */
  rank: number;
  /** Category totals for the period (FG%/FT% = summed makes / summed attempts). */
  stats: CategoryLine;
  /** Place among the league's teams in each category, 1 = best (fewest TO); ties share a place. */
  catRanks: Record<CategoryKey, number>;
  /** Starters' games that counted (game limits applied): the week's, or the season's added up. */
  gamesPlayed: number;
  /** Categories won, lost and tied against every other team, each week (the ranking). */
  allPlay: MatchupScore;
  /** The ranking's score: all-play category win %, ties counting half (0–1). */
  allPlayPct: number;
  isMine: boolean;
}

/** The focused team against one other team. */
export interface VersusRow {
  opponent: FantasyTeamSummary;
  /** Categories won, lost and tied (season: summed over the weeks). */
  score: MatchupScore;
  /** Week only: each category's outcome. */
  results: Record<CategoryKey, CategoryResult> | null;
  /** Season only: weeks won, lost and tied (a week is won by winning more categories). */
  weeks: MatchupScore | null;
  /** Week only: the real pairing that week. */
  isActual: boolean;
}

/** The /rankings page: ?view=week|season, ?week=N, ?team=ID. */
export interface RankingsView {
  season: number;
  period: RankingsPeriod;
  /** The week shown (week view), or null in the season view. */
  week: { week: number; startsOn: string; endsOn: string; isPlayoffs: boolean; status: MatchupWeek["status"] } | null;
  weekCount: number;
  /** Season view: regular-season weeks added up, the live one included. */
  weeksCounted: number;
  includesLiveWeek: boolean;
  /** Ranked; empty before the period has started. */
  rows: RankingsRow[];
  /** The team in Versus the league: ?team=, else the manager's, else first place. */
  focus: { team: FantasyTeamSummary; rank: number; matchups: MatchupScore; versus: VersusRow[] } | null;
  myTeam: FantasyTeamSummary | null;
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
  /** A waiver claim's FAAB bid, in whole dollars (what it cost if won). Null otherwise. */
  faabBid: number | null;
  /**
   * A waiver claim that lost and has no waiver run (imported from Yahoo): why, or "" when not
   * known. Null for everything that went through. Such claims only show inside waiver reports.
   */
  failureReason: string | null;
}

/** One claim in a waiver run summary. */
export interface WaiverRunClaim {
  team: FantasyTeamSummary;
  /** FAAB bid; null in leagues without bidding. */
  bid: number | null;
  won: boolean;
  drop: PlayerSummary | null;
  /** Why it failed (outbid, couldn't afford it, roster full, ...); null when won. */
  reason: string | null;
}

/**
 * A waiver report for Recent transactions: a waiver run that decided at least one
 * claim, or claims without a run (imported from Yahoo) that went through in the same
 * minute. Every claim, grouped by the player claimed; its won claims aren't listed
 * again as separate transactions.
 */
export interface WaiverRunEntry {
  /** The waiver run; null for imported claims grouped by time (failures only if the import had them). */
  id: number | null;
  /** When the run finished, ISO timestamp. */
  at: string;
  /** Any claim carried a bid (the league ran FAAB). */
  faab: boolean;
  won: number;
  failed: number;
  /** Players won first, then the rest; each player's claims winner first, then by bid (highest first). */
  players: { player: PlayerSummary; claims: WaiverRunClaim[] }[];
}

/** One row of Recent transactions: a transaction or a waiver report. */
export type TransactionEntry = { kind: "tx"; tx: LeagueTransaction } | { kind: "run"; run: WaiverRunEntry };

/**
 * Recent transactions (League page: the latest few) and /league/transactions (every one, a page at a time):
 * newest first, and the league's time zone for times.
 */
export interface RecentTransactions {
  timeZone: string;
  entries: TransactionEntry[];
  /** Entries in the whole feed, for "View all" and paging. */
  total: number;
  /** The viewer's team, when asked with their user id and they have one. */
  myTeamId: number | null;
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

// Injury alerts (Web Push): /api/me/push. Logic: src/lib/push/send.ts.

/** GET: the key browsers subscribe with; null when the server has no VAPID keys (alerts off). */
export interface PushConfigResponse {
  publicKey: string | null;
}

/** A browser's PushSubscription.toJSON(). */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** PUT: turn alerts on for this browser (a confirmation notification follows). */
export interface PushSubscribeRequest {
  subscription: PushSubscriptionInput;
}

/** DELETE: turn alerts off for this browser. */
export interface PushUnsubscribeRequest {
  endpoint: string;
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
  /** Null when healthy. */
  injury: PlayerInjury | null;
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
    /** Who may use each IL slot the league has, e.g. "Out or Day-To-Day". */
    ilRules: { slot: LineupSlot; text: string }[];
  };
  /** The lineup's date and today (Pacific, GAME_DAY_TZ: what the page labels "Today"), yyyy-mm-dd. */
  date: string;
  today: string;
  /** The league's today (its time zone): days before it are locked. Can be a day after `today` late at night. */
  lockedBefore: string;
  /** The matchup week containing `date`; null outside the schedule. */
  week: { week: number; startsOn: string; endsOn: string; isPlayoffs: boolean } | null;
  /** Each day of that week (or the Mon–Sun around `date`) with its NBA game count. */
  days: { date: string; nbaGames: number }[];
  players: LineupPlayer[];
  /** Starters' games against that week's game limits; null when the week has none (or outside the schedule). */
  gameLimits: GameLimitUsage | null;
  /** A game one of this day's roster plays in is in progress: the page polls while true. */
  live: boolean;
}

// Players' league status

/** The fantasy team a player is on. */
export interface PlayerOwner {
  teamId: number;
  abbreviation: string;
}

/** A free agent on waivers: adding him is a claim that processes at `clearsAt`. */
export interface PlayerWaiver {
  /** The waiver run that decides his claims (and after which he's a free agent), ISO UTC. */
  clearsAt: string;
  /**
   * dropped: recently dropped (leagues.waiver_days); game_started: his game
   * today has tipped off (waivers_after_game_start); all_adds: a free agent in a
   * league where every add is a claim (all_adds_by_claim), not really on waivers.
   */
  reason: "dropped" | "game_started" | "all_adds";
  droppedBy: FantasyTeamSummary | null;
}

/** How the league reviews accepted trades (leagues.trade_review). */
export type TradeReview = "none" | "commissioner" | "league_vote";

// Waivers (the League page's waiver order)

/** The League page's waiver order and settings. */
export interface WaiverOrder {
  type: "continual_rolling" | "reverse_standings" | "faab";
  timeZone: string;
  waiverTime: string;
  /** ISO weekdays waivers run on (1 = Mon ... 7 = Sun). */
  waiverDaysOfWeek: number[];
  waiverDays: number;
  waiversAfterGameStart: boolean;
  allAddsByClaim: boolean;
  nextRunAt: string;
  /** FAAB leagues: the season budget per team and the minimum bid. */
  faabBudget: number;
  faabMinBid: number;
  /** First claim first (in FAAB leagues: first on tied bids). faabBalance is null unless the league is FAAB. */
  teams: (FantasyTeamSummary & { priority: number; faabBalance: number | null })[];
}

// --- League settings (commissioner only) ---

/** Injury report statuses (player_injuries.status) the IL rules can name. */
export const INJURY_STATUSES = ["Out", "Doubtful", "Questionable", "Day-To-Day", "Probable"] as const;

/**
 * The rules on the leagues row the commissioner can change. GET /api/league/settings (any signed-in user)
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
  /** Every add is a claim at the next waiver run, free agents included. Drops alone stay immediate. */
  allAddsByClaim: boolean;
  /**
   * FAAB season budget per team, whole dollars. Switching the league to FAAB
   * gives every team this much; changing it later adds the difference to (or
   * takes it from) every team's remaining balance, never below $0.
   */
  faabBudget: number;
  /** Smallest FAAB bid allowed (0 allows $0 bids); at most the budget. */
  faabMinBid: number;
  /** Count of IL and IL+ slots (leagues.roster_slots). */
  ilSlots: number;
  ilStatuses: string[];
  ilPlusSlots: number;
  ilPlusStatuses: string[];
  /**
   * The waiver run lets a claim through when someone on the team's IL no longer
   * qualifies (his status changed after the claim was placed). Placing a claim
   * always needs a legal roster.
   */
  claimsIgnoreIlStatus: boolean;
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
  /**
   * Caps on starters' games per matchup week; null = no limits. A change
   * applies from the next matchup week (league_weeks.game_limits); the current
   * week keeps its limits.
   */
  gameLimits: GameLimits | null;
}

/**
 * Games a team's starters may play in one matchup week (lineup/gameLimits.ts).
 * Games count in tip-off order; once the team total or a slot's cap is
 * reached, later starts (for the team / in that slot) score nothing that week.
 */
export interface GameLimits {
  /** All starting slots together. */
  total: number;
  /** Per starting slot, shared by all of that slot's spots (C x2 = one cap). Missing = only the total applies. */
  slots: Partial<Record<LineupSlot, number>>;
}

/** One game limit's tally for a week. */
export interface GameLimitCount {
  limit: number;
  /** Games that counted so far. */
  used: number;
  /** What it will reach if the lineups as set now play out (scheduled games assumed played). */
  planned: number;
  /** Days (yyyy-mm-dd) with upcoming starts that won't count because of this limit. */
  blockedDays: string[];
}

/** A team's games against its week's limits (TeamLineupResponse.gameLimits). */
export interface GameLimitUsage {
  total: GameLimitCount;
  /** Capped slots only, in slot order. */
  slots: (GameLimitCount & { slot: LineupSlot })[];
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
  /** The league's starting slots and counts, for the per-position game limits. */
  startingSlots?: { slot: LineupSlot; count: number }[];
  /** The first week a game limits change would apply to (the next one to start); null = none left. */
  gameLimitsFromWeek?: number | null;
}

// Team names (the Yahoo import checks them)

/** Limits on a team's name and abbreviation. */
export const TEAM_NAME_LENGTH = { min: 2, max: 32 } as const;
/** 2–4 uppercase letters or digits, at least one letter. */
export const TEAM_ABBREVIATION = /^(?=.*[A-Z])[A-Z0-9]{2,4}$/;
/** Team logo images (team_logos.content_type). */
export const TEAM_LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

// Box scores (/box-scores)

/** What a box score cell is ranked on: the nine categories and Value. */
export type BoxRankKey = Category | "value";

/**
 * Where a stat ranks among every player who played that date (all games):
 * top 10% / 25% / 40%, the middle, bottom 25% / 10%. Ties share a place.
 */
export type RankTier = "top10" | "top25" | "top40" | "mid" | "bottom25" | "bottom10";

export interface BoxRank {
  /** 1-based; tied players share the best rank of the tie. */
  rank: number;
  tied: boolean;
  tier: RankTier;
}

export interface BoxScorePlayer {
  id: number;
  firstName: string;
  lastName: string;
  position: string | null;
  owner: PlayerOwner | null;
  /** Set when he's a free agent on waivers: adding him is a claim. */
  waiver: PlayerWaiver | null;
  /** His line, plus personal fouls (shown, not a category). Not null in practice: DNP (0-minute) lines are left off the box score. */
  line: (CategoryLine & { min: number; pf: number }) | null;
  /** Value of this one game (the Players page's per-game scale and your punt weights); null for DNP. */
  value: number | null;
  /** Ranks against the date's players; FG%/FT% missing with no attempts. Empty for DNP. */
  ranks: Partial<Record<BoxRankKey, BoxRank>>;
}

export interface BoxScoreTeam {
  id: number;
  abbreviation: string;
  /** Null before tip-off. */
  score: number | null;
  /** Players by Value, best first; players who did not play (0 minutes) are left off. */
  players: BoxScorePlayer[];
  totals: CategoryLine & { min: number; pf: number };
}

export interface BoxScoreGame {
  id: number;
  state: "scheduled" | "live" | "final" | "postponed";
  /** "Final", "Final/1OT", "Q4 5:06", "Halftime"; null when scheduled (show tipoff). */
  statusText: string | null;
  tipoff: string | null;
  away: BoxScoreTeam;
  home: BoxScoreTeam;
  /** Your rostered players whose NBA team plays in this game, by name. */
  mine: string[];
}

/** GET page /box-scores?date=yyyy-mm-dd (default today in the league's time zone). */
export interface BoxScoresResponse {
  date: string;
  today: string;
  timeZone: string;
  /** The week strip: the date and three days either side, with each one's number of games. */
  days: { date: string; games: number }[];
  /** The season's first and last game dates (the date picker's range); null with no schedule. */
  firstDate: string | null;
  lastDate: string | null;
  games: BoxScoreGame[];
  /** Players with minutes on this date, the pool the ranks are out of. */
  playerCount: number;
  myTeamId: number | null;
  /** A game on this date is in progress: the page polls (components/live). */
  live: boolean;
}

// --- Yahoo connection (GET /api/yahoo/status, POST /api/yahoo/refresh) ---

/** The league's Yahoo mirror, for YahooRefresh and /league/yahoo. Signed-in league members only. */
export interface YahooStatusResponse {
  /** YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET and YAHOO_TOKEN_KEY are set. */
  configured: boolean;
  connected: boolean;
  /** Yahoo's league key ("466.l.12345"); null until one is chosen. */
  leagueKey: string | null;
  connectedBy: string | null;
  connectedAt: string | null;
  /** Last successful sync of any kind (ISO). */
  lastRefreshAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Yahoo throttled us: no calls before this (ISO). */
  throttledUntil: string | null;
  /** The viewer may connect, reconnect, pick the league or disconnect (the commissioner). */
  canManage: boolean;
}

/** POST /api/yahoo/refresh: what the refresh did, and the status after it. */
export interface YahooRefreshResponse {
  ok: boolean;
  /** Why not, in words (throttled, failed, refreshed less than a minute ago). */
  message: string | null;
  status: YahooStatusResponse;
}

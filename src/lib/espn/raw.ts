// ESPN's JSON shapes (site.api.espn.com/apis/site/v2/sports/basketball/nba), only
// the fields we read. Undocumented and keyless; samples in data/samples/espn/.
// Ids are numeric strings. Event dates are UTC ("2026-11-17T00:00Z").

export interface EspnTeamRef {
  id: string;
  abbreviation: string;
  location?: string;
  name?: string;
  displayName?: string;
  shortDisplayName?: string;
}

/** GET teams */
export interface EspnTeamsResponse {
  sports: { leagues: { teams: { team: EspnTeamRef }[] }[] }[];
}

export interface EspnPosition {
  abbreviation?: string;
}

/** GET teams/{id}/roster */
export interface EspnRosterResponse {
  team?: EspnTeamRef;
  athletes: EspnRosterAthlete[];
}

export interface EspnRosterAthlete {
  id: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  displayName?: string;
  jersey?: string;
  position?: EspnPosition;
}

export interface EspnStatusType {
  /** STATUS_SCHEDULED, STATUS_IN_PROGRESS, STATUS_HALFTIME, STATUS_END_PERIOD, STATUS_FINAL, STATUS_POSTPONED, STATUS_CANCELED, ... */
  name: string;
  /** pre | in | post */
  state: string;
  completed?: boolean;
  description?: string;
  detail?: string;
  shortDetail?: string;
}

export interface EspnStatus {
  clock?: number;
  displayClock?: string;
  period?: number;
  type: EspnStatusType;
}

export interface EspnCompetitor {
  id: string;
  homeAway: "home" | "away";
  /** A string on the scoreboard, an object on team schedules; absent before tip-off. */
  score?: string | { value?: number; displayValue?: string };
  team: EspnTeamRef;
}

export interface EspnCompetition {
  id: string;
  date: string;
  /** e.g. { abbreviation: "STD" } regular, "CC" NBA Cup Championship. */
  type?: { id?: string; abbreviation?: string };
  notes?: { headline?: string }[];
  competitors: EspnCompetitor[];
  status: EspnStatus;
}

export interface EspnEvent {
  id: string;
  date: string;
  name?: string;
  /** year 2027 = our season 2026 (2026-27). type 1 preseason, 2 regular, 3 postseason, 4 all-star, 5 play-in. */
  season: { year: number; type?: number };
  /** Team schedules carry the season type here instead. */
  seasonType?: { type?: number };
  competitions: EspnCompetition[];
  /** Scoreboard events have it at the top level too. */
  status?: EspnStatus;
}

/** GET scoreboard?dates=YYYYMMDD */
export interface EspnScoreboardResponse {
  leagues?: { calendar?: string[]; season?: { year: number } }[];
  events: EspnEvent[];
}

/** GET teams/{id}/schedule?season=YYYY&seasontype=N */
export interface EspnScheduleResponse {
  events?: EspnEvent[];
}

export interface EspnBoxAthlete {
  athlete: { id: string; displayName?: string; shortName?: string; jersey?: string; position?: EspnPosition };
  starter?: boolean;
  didNotPlay?: boolean;
  /** Same order as the block's labels; empty for a DNP. */
  stats: string[];
}

export interface EspnBoxTeam {
  team: EspnTeamRef;
  /** [0] is the box score: labels MIN, PTS, FG, 3PT, FT, REB, AST, TO, STL, BLK, OREB, DREB, PF, +/- */
  statistics: { labels: string[]; athletes: EspnBoxAthlete[] }[];
}

/** GET summary?event={id} */
export interface EspnSummaryResponse {
  header: {
    id: string;
    season: { year: number; type?: number };
    competitions: EspnCompetition[];
  };
  boxscore: { players?: EspnBoxTeam[] };
}

export interface EspnInjury {
  id: string;
  /** "Out", "Day-To-Day", "Suspension", ... */
  status: string;
  date?: string;
  shortComment?: string;
  longComment?: string;
  athlete: {
    firstName?: string;
    lastName?: string;
    displayName?: string;
    position?: EspnPosition;
    team?: EspnTeamRef;
    /** The athlete id is only in these (".../id/3146557/jock-landale"). */
    links?: { href?: string }[];
    headshot?: { href?: string };
  };
  details?: {
    type?: string;
    location?: string;
    detail?: string;
    side?: string;
    /** yyyy-mm-dd */
    returnDate?: string;
    fantasyStatus?: { abbreviation?: string; description?: string };
  };
}

/** GET injuries: one entry per team. */
export interface EspnInjuriesResponse {
  injuries: { id: string; displayName?: string; injuries: EspnInjury[] }[];
}

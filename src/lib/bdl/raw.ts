// Raw BALLDONTLIE response shapes, derived from the real responses in
// data/samples/. Only this module (src/lib/bdl) should import these; callers
// use the provider-neutral types in ./types.ts.

export interface BdlTeam {
  id: number;
  /** null/"" for defunct franchises (only ids 1–30 are current NBA teams). */
  conference: string | null;
  division: string | null;
  city: string | null;
  name: string | null;
  full_name: string | null;
  abbreviation: string;
}

interface BdlPlayerBase {
  id: number;
  first_name: string;
  last_name: string;
  /** "G", "F", "C", "G-F", "C-F", ... or "" */
  position: string | null;
  height: string | null;
  weight: string | null;
  jersey_number: string | null;
  college: string | null;
  country: string | null;
  draft_year: number | null;
  draft_round: number | null;
  draft_number: number | null;
}

/** `/players` rows carry a nested team object. */
export interface BdlPlayer extends BdlPlayerBase {
  team: BdlTeam | null;
}

/** Players nested in `/stats` and `/player_injuries` carry only `team_id`. */
export interface BdlNestedPlayer extends BdlPlayerBase {
  team_id: number | null;
}

interface BdlGameBase {
  id: number;
  /** yyyy-mm-dd */
  date: string;
  /** 2026 = the 2026-27 season */
  season: number;
  /** "Final", or a start time / quarter while not final */
  status: string;
  /** e.g. "final" */
  status_state: string | null;
  period: number | null;
  time: string | null;
  postseason: boolean;
  postponed: boolean | null;
  home_team_score: number | null;
  visitor_team_score: number | null;
  /** ISO timestamp of tip-off */
  datetime: string | null;
  home_q1: number | null;
  home_q2: number | null;
  home_q3: number | null;
  home_q4: number | null;
  home_ot1: number | null;
  home_ot2: number | null;
  home_ot3: number | null;
  visitor_q1: number | null;
  visitor_q2: number | null;
  visitor_q3: number | null;
  visitor_q4: number | null;
  visitor_ot1: number | null;
  visitor_ot2: number | null;
  visitor_ot3: number | null;
  ist_stage: string | null;
}

/** `/games` rows carry nested team objects. */
export interface BdlGame extends BdlGameBase {
  home_team: BdlTeam;
  visitor_team: BdlTeam;
}

/** Games nested in `/stats` carry only team ids. */
export interface BdlNestedGame extends BdlGameBase {
  home_team_id: number;
  visitor_team_id: number;
}

export interface BdlStat {
  id: number;
  /** "MM:SS" or "0" (DNP). */
  min: string | null;
  fgm: number | null;
  fga: number | null;
  fg_pct: number | null;
  fg3m: number | null;
  fg3a: number | null;
  fg3_pct: number | null;
  ftm: number | null;
  fta: number | null;
  ft_pct: number | null;
  oreb: number | null;
  dreb: number | null;
  reb: number | null;
  ast: number | null;
  stl: number | null;
  blk: number | null;
  turnover: number | null;
  pf: number | null;
  pts: number | null;
  plus_minus: number | null;
  player: BdlNestedPlayer;
  /** The team the player played for in this game. */
  team: BdlTeam;
  game: BdlNestedGame;
}

export interface BdlInjury {
  player: BdlNestedPlayer;
  /** Full ISO date, e.g. "2026-10-28". */
  return_date: string | null;
  description: string | null;
  /** Available | Day-To-Day | Doubtful | Out | Probable | Questionable */
  status: string;
}

export interface BdlMeta {
  next_cursor?: number | null;
  per_page?: number;
}

export interface BdlPage<T> {
  data: T[];
  meta?: BdlMeta;
}

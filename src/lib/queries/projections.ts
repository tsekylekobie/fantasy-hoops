// Matchup projections (the /matchup page's Projected view). Pure functions, so
// they can be unit tested; the per-game bases come from queries/players.ts.
//
// Rules: a team's projected week = its week so far (as scored by matchups.ts)
// plus one per-game average for every start still to tip off that will count
// under the week's game limits, on the lineups as set (a player benched for a
// day projects nothing that day). The average is his last PROJECTION_DAYS days
// (the Players page's "Last 30 days") when he played at least
// PROJECTION_MIN_GP games in them, else his season; no games this season
// projects nothing. A player listed Out projects nothing until his estimated
// return (for good when there's none), and those games don't use up a game limit.
import type { PlayerInjury } from "../types";
import type { SeasonTotals } from "./value";

export const PROJECTION_DAYS = 30;
export const PROJECTION_MIN_GP = 5;

/** Per-game makes, attempts and counting stats; gp is the games it stands for. */
export interface ProjectedLine {
  gp: number;
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

const STATS = ["fgm", "fga", "ftm", "fta", "fg3m", "pts", "reb", "ast", "stl", "blk", "tov"] as const;

/** One game at the player's average: last PROJECTION_DAYS days with enough games, else season. Null without games. */
export function perGameBasis(recent: SeasonTotals | undefined, season: SeasonTotals | undefined): ProjectedLine | null {
  const t = recent && recent.gp >= PROJECTION_MIN_GP ? recent : season;
  if (!t || t.gp === 0) return null;
  const out = { gp: 1 } as ProjectedLine;
  for (const k of STATS) out[k] = t[k] / t.gp;
  return out;
}

/** Whether he's expected to miss a game on `date` (yyyy-mm-dd): listed Out, back on his return date. */
export function sitsOut(injury: PlayerInjury | null | undefined, date: string): boolean {
  return injury?.status === "Out" && (injury.returnDate === null || date < injury.returnDate);
}

/** Sums `n` games of `basis` onto `into` (in place). */
export function addGames<T extends ProjectedLine>(into: T, basis: ProjectedLine, n = 1): T {
  into.gp += n;
  for (const k of STATS) into[k] += basis[k] * n;
  return into;
}

export const emptyProjection = (): ProjectedLine => ({
  gp: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, fg3m: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0,
});

/**
 * What each (team, player)'s remaining starts add, keyed "team:player". Starts
 * of players without a basis add nothing and are left out.
 */
export function projectStarts(
  starts: readonly { team_id: number; player_id: number }[],
  bases: Map<number, ProjectedLine>,
): Map<string, ProjectedLine & { team_id: number; player_id: number }> {
  const out = new Map<string, ProjectedLine & { team_id: number; player_id: number }>();
  for (const s of starts) {
    const basis = bases.get(s.player_id);
    if (!basis) continue;
    const key = `${s.team_id}:${s.player_id}`;
    const row = out.get(key) ?? { ...emptyProjection(), team_id: s.team_id, player_id: s.player_id };
    out.set(key, addGames(row, basis));
  }
  return out;
}

/** Whole makes, attempts and counts, for showing and comparing (percentages come from the rounded makes/attempts). */
export function roundLine<T extends ProjectedLine>(t: T): T {
  const out = { ...t };
  for (const k of STATS) out[k] = Math.round(t[k]);
  return out;
}

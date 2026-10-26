// Regular-season records, shared by the League page's standings (league.ts)
// and the playoff seeds (playoffs.ts). Playoff and toilet bowl weeks never
// count toward the standings.
import type { Pool } from "pg";
import type { CategoryLine, MatchupScore } from "../types";
import { compareLines, emptyLine, weekLines } from "./matchups";

export interface WeekRow {
  week: number;
  starts_on: string;
  ends_on: string;
  is_playoffs: boolean;
}

export interface PairRow {
  week: number;
  team_a_id: number;
  team_b_id: number | null;
}

export type LinesByWeek = Map<number, Map<number, CategoryLine>>;

export const WEEKS_SQL = `SELECT week, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on, is_playoffs
  FROM league_weeks WHERE league_id = $1 ORDER BY week`;

/** The first playoff week: leagues.playoff_start_week, else the first week flagged is_playoffs; null = no playoffs scheduled. */
export function playoffStart(weeks: WeekRow[], playoffStartWeek: number | null): number | null {
  return playoffStartWeek ?? weeks.find((w) => w.is_playoffs)?.week ?? null;
}

/** A regular-season week: before the playoffs start. */
export const isRegularWeek = (w: WeekRow, start: number | null) => !w.is_playoffs && (start === null || w.week < start);

/** Each team's week lines, for every week that has started by `today`. */
export async function startedWeekLines(db: Pool, leagueId: number, weeks: WeekRow[], today: string): Promise<LinesByWeek> {
  const started = weeks.filter((w) => w.starts_on <= today);
  const lines = await Promise.all(
    started.map((w) => weekLines(db, leagueId, { startsOn: w.starts_on, endsOn: w.ends_on }, today)),
  );
  return new Map(started.map((w, i) => [w.week, lines[i]]));
}

/** Categories for `a` against `b` in `week`; all zeros before the week has lines. */
export function scoreIn(lines: LinesByWeek, week: number, a: number, b: number): MatchupScore {
  const l = lines.get(week);
  return l ? compareLines(l.get(a) ?? emptyLine(), l.get(b) ?? emptyLine()).score : { wins: 0, losses: 0, ties: 0 };
}

/** Category records (W–L–T) from `pairs` in the weeks of `lines`. Byes count for nothing. */
export function recordsFrom(teamIds: number[], pairs: PairRow[], lines: LinesByWeek): Map<number, MatchupScore> {
  const records = new Map<number, MatchupScore>(teamIds.map((id) => [id, { wins: 0, losses: 0, ties: 0 }]));
  for (const p of pairs) {
    if (p.team_b_id === null || !lines.has(p.week)) continue;
    const s = scoreIn(lines, p.week, p.team_a_id, p.team_b_id);
    const a = records.get(p.team_a_id);
    const b = records.get(p.team_b_id);
    if (!a || !b) continue;
    a.wins += s.wins; a.losses += s.losses; a.ties += s.ties;
    b.wins += s.losses; b.losses += s.wins; b.ties += s.ties;
  }
  return records;
}

// Power rankings behind the /rankings page: every team's week against every
// other team's ("all-play"), so a team's place doesn't depend on who it drew.
//
// Rules: each pair of teams is compared category by category the way a real
// matchup is (compareLines). The stack rank orders teams by all-play category
// win % (ties count half), then category wins, then name, like the standings.
// The season view adds up every regular-season week played, the live one
// included (playoff and toilet bowl weeks don't count, as in standings.ts);
// its category totals are summed lines (FG%/FT% from summed makes / attempts).
import type { Pool } from "pg";
import type {
  CategoryKey,
  CategoryLine,
  CategoryResult,
  FantasyTeamSummary,
  MatchupScore,
  RankingsPeriod,
  RankingsRow,
  RankingsView,
  VersusRow,
} from "../types";
import { CATEGORY_KEYS } from "../types";
import { standingsOrder, winPct } from "../playoffs/bracket";
import { compareLines, emptyLine, weekLines } from "./matchups";
import { WEEKS_SQL, isRegularWeek, playoffStart, startedWeekLines, type WeekRow } from "./standings";
import { toTeamSummary, type TeamRow } from "./teamLogo";

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const zero = (): MatchupScore => ({ wins: 0, losses: 0, ties: 0 });

function add(into: MatchupScore, s: MatchupScore): void {
  into.wins += s.wins;
  into.losses += s.losses;
  into.ties += s.ties;
}

/** A matchup's outcome from its category score: more categories won wins. */
function outcome(s: MatchupScore): MatchupScore {
  return s.wins > s.losses ? { wins: 1, losses: 0, ties: 0 } : s.wins < s.losses ? { wins: 0, losses: 1, ties: 0 } : { wins: 0, losses: 0, ties: 1 };
}

/** Two lines added together; percentages from the summed makes and attempts. */
export function addLines(a: CategoryLine, b: CategoryLine): CategoryLine {
  const fgm = a.fgm + b.fgm, fga = a.fga + b.fga, ftm = a.ftm + b.ftm, fta = a.fta + b.fta;
  return {
    fgm, fga, fgPct: fga > 0 ? r3(fgm / fga) : null,
    ftm, fta, ftPct: fta > 0 ? r3(ftm / fta) : null,
    fg3m: a.fg3m + b.fg3m, pts: a.pts + b.pts, reb: a.reb + b.reb, ast: a.ast + b.ast,
    stl: a.stl + b.stl, blk: a.blk + b.blk, tov: a.tov + b.tov,
  };
}

export interface AllPlay {
  /** Categories against every other team. */
  record: MatchupScore;
  /** Against each other team. */
  vs: Map<number, { results: Record<CategoryKey, CategoryResult>; score: MatchupScore }>;
}

/** Each team's week against every other team's. A team missing from `lines` has an empty line. */
export function allPlay(teamIds: number[], lines: Map<number, CategoryLine>): Map<number, AllPlay> {
  const line = (id: number) => lines.get(id) ?? emptyLine();
  return new Map(teamIds.map((id) => {
    const out: AllPlay = { record: zero(), vs: new Map() };
    for (const opp of teamIds) {
      if (opp === id) continue;
      const c = compareLines(line(id), line(opp));
      out.vs.set(opp, c);
      add(out.record, c.score);
    }
    return [id, out];
  }));
}

/**
 * Each team's place in each category, 1 = best (fewest TO), ties sharing a
 * place. Compared like compareLines: no attempts sits below any percentage.
 */
export function categoryRanks(teamIds: number[], lines: Map<number, CategoryLine>): Map<number, Record<CategoryKey, number>> {
  const line = (id: number) => lines.get(id) ?? emptyLine();
  const ranks = new Map(teamIds.map((id) => [id, {} as Record<CategoryKey, number>]));
  for (const key of CATEGORY_KEYS) {
    const value = (id: number) => line(id)[key] ?? -1;
    for (const id of teamIds) {
      const v = value(id);
      ranks.get(id)![key] = 1 + teamIds.filter((o) => (key === "tov" ? value(o) < v : value(o) > v)).length;
    }
  }
  return ranks;
}

export interface RankingsOptions {
  period: RankingsPeriod;
  /** Week view: the week to show; null = the week containing today (clamped to the season). */
  week: number | null;
  /** The team in Versus the league; null = the manager's. */
  teamId: number | null;
}

/** The season league's power rankings for `userId` (null = signed out). Null without a league or schedule. */
export async function getRankings(db: Pool, season: number, userId: number | null, opts: RankingsOptions): Promise<RankingsView | null> {
  const { rows: [league] } = await db.query<{ id: number; playoff_start_week: number | null; today: string }>(
    `SELECT id::int, playoff_start_week, to_char((now() AT TIME ZONE time_zone)::date, 'YYYY-MM-DD') AS today
     FROM leagues WHERE season = $1 ORDER BY id LIMIT 1`,
    [season],
  );
  if (!league) return null;
  const { today } = league;

  const [{ rows: teams }, { rows: weeks }] = await Promise.all([
    db.query<TeamRow & { owner_user_id: number | null }>(
      `SELECT id::int, name, abbreviation, logo_updated_at, owner_user_id::int FROM fantasy_teams WHERE league_id = $1 ORDER BY name`,
      [league.id],
    ),
    db.query<WeekRow>(WEEKS_SQL, [league.id]),
  ]);
  if (weeks.length === 0) return null;
  const ids = teams.map((t) => t.id);
  const summary = new Map<number, FantasyTeamSummary>(teams.map((t) => [t.id, toTeamSummary(t)]));
  const mine = userId === null ? undefined : teams.find((t) => t.owner_user_id === userId);
  const status = (w: WeekRow) => (today < w.starts_on ? "upcoming" : today > w.ends_on ? "final" : "live") as "upcoming" | "live" | "final";

  // Period totals, all-play record, and each pair's score (and, for the season, weeks won).
  let totals = new Map<number, CategoryLine>();
  const record = new Map(ids.map((id) => [id, zero()]));
  const pairScore = new Map<string, MatchupScore>();
  const pairWeeks = new Map<string, MatchupScore>();
  let results: Map<number, AllPlay> | null = null;
  const key = (a: number, b: number) => `${a}:${b}`;

  let shownWeek: RankingsView["week"] = null;
  let counted: WeekRow[] = [];
  const actual = new Set<string>();

  if (opts.period === "week") {
    const w = (opts.week !== null && weeks.find((x) => x.week === opts.week)) || weeks.find((x) => today <= x.ends_on) || weeks[weeks.length - 1];
    shownWeek = { week: w.week, startsOn: w.starts_on, endsOn: w.ends_on, isPlayoffs: w.is_playoffs, status: status(w) };
    if (w.starts_on <= today) {
      totals = await weekLines(db, league.id, { startsOn: w.starts_on, endsOn: w.ends_on }, today);
      results = allPlay(ids, totals);
      const { rows: pairs } = await db.query<{ team_a_id: number; team_b_id: number | null }>(
        `SELECT team_a_id::int, team_b_id::int FROM matchups WHERE league_id = $1 AND week = $2`,
        [league.id, w.week],
      );
      for (const p of pairs) {
        if (p.team_b_id === null) continue;
        actual.add(key(p.team_a_id, p.team_b_id));
        actual.add(key(p.team_b_id, p.team_a_id));
      }
    }
  } else {
    const start = playoffStart(weeks, league.playoff_start_week);
    counted = weeks.filter((w) => isRegularWeek(w, start) && w.starts_on <= today);
    const byWeek = await startedWeekLines(db, league.id, counted, today);
    for (const lines of byWeek.values()) {
      for (const [id, l] of lines) totals.set(id, addLines(totals.get(id) ?? emptyLine(), l));
      for (const [id, ap] of allPlay(ids, lines)) {
        add(record.get(id)!, ap.record);
        for (const [opp, c] of ap.vs) {
          const k = key(id, opp);
          if (!pairScore.has(k)) { pairScore.set(k, zero()); pairWeeks.set(k, zero()); }
          add(pairScore.get(k)!, c.score);
          add(pairWeeks.get(k)!, outcome(c.score));
        }
      }
    }
  }
  if (results) {
    for (const [id, ap] of results) {
      record.set(id, ap.record);
      for (const [opp, c] of ap.vs) pairScore.set(key(id, opp), c.score);
    }
  }

  const started = opts.period === "week" ? results !== null : counted.length > 0;
  const catRanks = categoryRanks(ids, totals);
  const sorted = standingsOrder(teams.map((t) => ({ ...t, record: record.get(t.id)! })));
  const rows: RankingsRow[] = [];
  if (started) {
    sorted.forEach((t, i) => {
      const prev = sorted[i - 1];
      const tied = prev !== undefined && winPct(prev.record) === winPct(t.record) && prev.record.wins === t.record.wins;
      rows.push({
        ...summary.get(t.id)!,
        rank: tied ? rows[i - 1].rank : i + 1,
        stats: totals.get(t.id) ?? emptyLine(),
        catRanks: catRanks.get(t.id)!,
        allPlay: t.record,
        isMine: t.id === mine?.id,
      });
    });
  }

  // Versus the league: the focused team against everyone else, in rank order.
  const focusId = opts.teamId !== null && summary.has(opts.teamId) ? opts.teamId : mine?.id ?? rows[0]?.id;
  let focus: RankingsView["focus"] = null;
  const focusRow = rows.find((r) => r.id === focusId);
  if (focusRow) {
    const matchups = zero();
    const versus: VersusRow[] = rows.filter((r) => r.id !== focusRow.id).map((r) => {
      const k = key(focusRow.id, r.id);
      const score = pairScore.get(k) ?? zero();
      const weeksRec = opts.period === "season" ? pairWeeks.get(k) ?? zero() : null;
      add(matchups, weeksRec ?? outcome(score));
      return {
        opponent: summary.get(r.id)!,
        score,
        results: results?.get(focusRow.id)?.vs.get(r.id)?.results ?? null,
        weeks: weeksRec,
        isActual: actual.has(k),
      };
    });
    focus = { team: summary.get(focusRow.id)!, rank: focusRow.rank, matchups, versus };
  }

  return {
    season,
    period: opts.period,
    week: shownWeek,
    weekCount: weeks.length,
    weeksCounted: counted.length,
    includesLiveWeek: counted.some((w) => status(w) === "live"),
    rows,
    focus,
    myTeam: mine ? summary.get(mine.id)! : null,
  };
}

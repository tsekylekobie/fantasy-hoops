// Head-to-head week scoring behind the /matchup page.
//
// Rules: a team's week is the regular-season games its starters played on the
// days they were started. A day's lineup is its lineup_slots rows, or the
// standing lineup (roster_players.slot) when that day has none. BN, IL and
// IL+ don't score. FG%/FT% = summed makes / summed attempts; TO is
// lower-is-better. Scores are computed on read (no scoring job yet).
import type { Pool } from "pg";
import type {
  CategoryKey,
  CategoryLine,
  CategoryResult,
  FantasyTeamSummary,
  MatchupScore,
  MatchupSide,
  MatchupWeek,
  PlayerSummary,
} from "../types";
import { CATEGORY_KEYS } from "../types";

const NON_SCORING = `('BN','IL','IL+')`;

// $1 league, $2 starts_on, $3 ends_on. Each team's starters for each day.
const STARTERS_CTE = `
  days AS (SELECT d::date AS date FROM generate_series($2::date, $3::date, interval '1 day') d),
  lineup AS (
    SELECT ls.fantasy_team_id AS team_id, ls.date, ls.player_id, ls.slot
    FROM lineup_slots ls
    WHERE ls.league_id = $1 AND ls.date BETWEEN $2::date AND $3::date
    UNION ALL
    SELECT rp.fantasy_team_id, d.date, rp.player_id, rp.slot
    FROM roster_players rp CROSS JOIN days d
    WHERE rp.league_id = $1
      AND NOT EXISTS (SELECT 1 FROM lineup_slots ls
                      WHERE ls.fantasy_team_id = rp.fantasy_team_id AND ls.date = d.date)
  ),
  starters AS (SELECT team_id, date, player_id FROM lineup WHERE slot NOT IN ${NON_SCORING})`;

const PLAYED_SQL = `
  WITH ${STARTERS_CTE}
  SELECT st.team_id::int AS team_id,
         count(*)::int                     AS gp,
         coalesce(sum(s.fgm), 0)::int      AS fgm,
         coalesce(sum(s.fga), 0)::int      AS fga,
         coalesce(sum(s.ftm), 0)::int      AS ftm,
         coalesce(sum(s.fta), 0)::int      AS fta,
         coalesce(sum(s.fg3m), 0)::int     AS fg3m,
         coalesce(sum(s.pts), 0)::int      AS pts,
         coalesce(sum(s.reb), 0)::int      AS reb,
         coalesce(sum(s.ast), 0)::int      AS ast,
         coalesce(sum(s.stl), 0)::int      AS stl,
         coalesce(sum(s.blk), 0)::int      AS blk,
         coalesce(sum(s.turnover), 0)::int AS tov
  FROM starters st
  JOIN games g ON g.date = st.date AND g.game_type = 'regular'
  JOIN player_game_stats s ON s.game_id = g.id AND s.player_id = st.player_id AND s.min > 0
  -- Redundant with the join, but it lets the planner start from the week's games.
  WHERE g.date BETWEEN $2::date AND $3::date
  GROUP BY st.team_id`;

// Games not yet started, from $4 (today) on, for each day's starters' current NBA teams.
const LEFT_SQL = `
  WITH ${STARTERS_CTE}
  SELECT st.team_id::int AS team_id, count(*)::int AS left
  FROM starters st
  JOIN players p ON p.id = st.player_id
  JOIN games g ON g.date = st.date AND p.team_id IN (g.home_team_id, g.visitor_team_id)
  WHERE st.date >= $4::date AND g.game_type = 'regular' AND NOT g.postponed
    AND coalesce(g.status_state, 'scheduled') = 'scheduled'
  GROUP BY st.team_id`;

// One team's starters on $4 (today) whose NBA team has no game that day.
const IDLE_SQL = `
  WITH ${STARTERS_CTE}
  SELECT p.id, p.first_name, p.last_name, nullif(p.position, '') AS position,
         p.nba_person_id, tm.abbreviation AS team_abbr
  FROM starters st
  JOIN players p ON p.id = st.player_id
  LEFT JOIN teams tm ON tm.id = p.team_id
  WHERE st.team_id = $5 AND st.date = $4::date
    AND NOT EXISTS (SELECT 1 FROM games g
                    WHERE g.date = st.date AND NOT g.postponed
                      AND p.team_id IN (g.home_team_id, g.visitor_team_id))
  ORDER BY p.last_name, p.first_name`;

interface Totals {
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

const ZERO: Totals = { gp: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, fg3m: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0 };

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const pct = (makes: number, attempts: number) => (attempts > 0 ? r3(makes / attempts) : null);

function weekLine(t: Totals): CategoryLine {
  return {
    fgm: t.fgm, fga: t.fga, fgPct: pct(t.fgm, t.fga),
    ftm: t.ftm, fta: t.fta, ftPct: pct(t.ftm, t.fta),
    fg3m: t.fg3m, pts: t.pts, reb: t.reb, ast: t.ast, stl: t.stl, blk: t.blk, tov: t.tov,
  };
}

/**
 * Category outcomes for side `a`. Percentages compare at the three decimals
 * shown, so the display never shows equal values with a winner. A side with
 * no attempts loses the percentage to one with attempts.
 */
export function compareLines(a: CategoryLine, b: CategoryLine): { results: Record<CategoryKey, CategoryResult>; score: MatchupScore } {
  const results = {} as Record<CategoryKey, CategoryResult>;
  const score: MatchupScore = { wins: 0, losses: 0, ties: 0 };
  for (const key of CATEGORY_KEYS) {
    const x = a[key] ?? -1;
    const y = b[key] ?? -1;
    const better = key === "tov" ? y - x : x - y;
    const r: CategoryResult = better > 0 ? "win" : better < 0 ? "loss" : "tie";
    results[key] = r;
    if (r === "win") score.wins++;
    else if (r === "loss") score.losses++;
    else score.ties++;
  }
  return { results, score };
}

interface TeamRow {
  id: number;
  name: string;
  abbreviation: string;
  owner_user_id: number | null;
}

interface WeekRow {
  week: number;
  starts_on: string;
  ends_on: string;
  is_playoffs: boolean;
}

/**
 * One week of the season's league for `userId` (null = signed out).
 * `week` null picks the week containing today (clamped to the season).
 * Returns null when there is no league or schedule for the season.
 */
export async function getMatchupWeek(
  db: Pool,
  season: number,
  week: number | null,
  userId: number | null,
): Promise<MatchupWeek | null> {
  const { rows: [league] } = await db.query<{ id: number; today: string }>(
    `SELECT id::int, to_char((now() AT TIME ZONE time_zone)::date, 'YYYY-MM-DD') AS today
     FROM leagues WHERE season = $1 ORDER BY id LIMIT 1`,
    [season],
  );
  if (!league) return null;
  const { today } = league;

  const { rows: weeks } = await db.query<WeekRow>(
    `SELECT week, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on, is_playoffs
     FROM league_weeks WHERE league_id = $1 ORDER BY week`,
    [league.id],
  );
  if (weeks.length === 0) return null;
  const w =
    (week !== null && weeks.find((x) => x.week === week)) ||
    weeks.find((x) => today <= x.ends_on) ||
    weeks[weeks.length - 1];

  const { rows: teams } = await db.query<TeamRow>(
    `SELECT id::int, name, abbreviation, owner_user_id::int FROM fantasy_teams WHERE league_id = $1`,
    [league.id],
  );
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const summary = (id: number): FantasyTeamSummary => {
    const t = teamById.get(id)!;
    return { id: t.id, name: t.name, abbreviation: t.abbreviation };
  };
  const mine = userId === null ? undefined : teams.find((t) => t.owner_user_id === userId);

  const params = [league.id, w.starts_on, w.ends_on, today];
  const [played, left, pairs] = await Promise.all([
    db.query<Totals & { team_id: number }>(PLAYED_SQL, params.slice(0, 3)),
    db.query<{ team_id: number; left: number }>(LEFT_SQL, params),
    db.query<{ team_a_id: number; team_b_id: number | null }>(
      `SELECT team_a_id::int, team_b_id::int FROM matchups WHERE league_id = $1 AND week = $2 ORDER BY id`,
      [league.id, w.week],
    ),
  ]);
  const totals = new Map(played.rows.map((r) => [r.team_id, r]));
  const gamesLeft = new Map(left.rows.map((r) => [r.team_id, r.left]));
  const side = (id: number): MatchupSide => {
    const t = totals.get(id) ?? ZERO;
    return { ...summary(id), stats: weekLine(t), gamesPlayed: t.gp, gamesLeft: gamesLeft.get(id) ?? 0 };
  };

  const status = today < w.starts_on ? "upcoming" : today > w.ends_on ? "final" : "live";
  const dayMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  const days = (dayMs(w.ends_on) - dayMs(w.starts_on)) / 86_400_000 + 1;

  let matchup: MatchupWeek["matchup"] = null;
  const others: MatchupWeek["others"] = [];
  for (const p of pairs.rows) {
    if (mine && p.team_b_id !== null && (p.team_a_id === mine.id || p.team_b_id === mine.id)) {
      const team = side(mine.id);
      const opponent = side(p.team_a_id === mine.id ? p.team_b_id : p.team_a_id);
      matchup = { team, opponent, ...compareLines(team.stats, opponent.stats) };
      continue;
    }
    const score =
      p.team_b_id === null
        ? { wins: 0, losses: 0, ties: 0 }
        : compareLines(side(p.team_a_id).stats, side(p.team_b_id).stats).score;
    others.push({ teamA: summary(p.team_a_id), teamB: p.team_b_id === null ? null : summary(p.team_b_id), score });
  }

  let idleStarters: PlayerSummary[] = [];
  if (mine && status === "live") {
    const { rows } = await db.query<{
      id: number;
      first_name: string;
      last_name: string;
      position: string | null;
      nba_person_id: number | null;
      team_abbr: string | null;
    }>(IDLE_SQL, [...params, mine.id]);
    idleStarters = rows.map((r) => ({
      id: r.id, firstName: r.first_name, lastName: r.last_name, teamAbbr: r.team_abbr,
      position: r.position, nbaPersonId: r.nba_person_id,
    }));
  }

  return {
    season,
    week: w.week,
    weekCount: weeks.length,
    startsOn: w.starts_on,
    endsOn: w.ends_on,
    isPlayoffs: w.is_playoffs,
    status,
    day: status === "live" ? (dayMs(today) - dayMs(w.starts_on)) / 86_400_000 + 1 : null,
    days,
    matchup,
    myTeam: mine ? summary(mine.id) : null,
    idleStarters,
    others,
  };
}

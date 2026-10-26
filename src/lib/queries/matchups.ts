// Head-to-head week scoring behind the /matchup page.
//
// Rules: a team's week is the regular-season games its starters played on the
// days they were started. A day's lineup is resolved as in queries/lineup.ts:
// the latest lineup_slots rows on or before that day (current roster only,
// newcomers on BN, plus departed players on past days with their own rows),
// or the standing lineup (roster_players.slot) before a team's first edit.
// BN, IL and IL+ don't score. Under the week's game limits
// (league_weeks.game_limits, lineup/gameLimits.ts) starts past a limit don't
// count either. FG%/FT% = summed makes / summed attempts of the games that
// count; TO is lower-is-better. Scores are computed on read (no scoring job yet).
import type { Pool } from "pg";
import { countStarts, gameLimitUsage, parseGameLimits, type Start } from "../lineup/gameLimits";
import type {
  CategoryKey,
  CategoryLine,
  CategoryResult,
  FantasyTeamSummary,
  GameLimitUsage,
  GameLimits,
  LineupGame,
  LineupSlot,
  MatchupPlayer,
  MatchupScore,
  MatchupSide,
  MatchupWeek,
} from "../types";
import { CATEGORY_KEYS, LINEUP_SLOTS } from "../types";
import { bracketTag, configOf, type BracketRow } from "./playoffs";
import { toTeamSummary } from "./teamLogo";

const NON_SCORING = `('BN','IL','IL+')`;

// $1 league, $2 starts_on, $3 ends_on, $4 today. Every team's lineup for each day of the week.
const LINEUP_CTE = `
  days AS (SELECT d::date AS date FROM generate_series($2::date, $3::date, interval '1 day') d),
  src AS (
    SELECT ft.id AS team_id, d.date,
           (SELECT max(ls.date) FROM lineup_slots ls WHERE ls.fantasy_team_id = ft.id AND ls.date <= d.date) AS src
    FROM fantasy_teams ft CROSS JOIN days d
    WHERE ft.league_id = $1
  ),
  lineup AS (
    SELECT s.team_id, s.date, rp.player_id,
           CASE WHEN s.src IS NULL THEN rp.slot ELSE coalesce(ls.slot, 'BN') END AS slot
    FROM src s
    JOIN roster_players rp ON rp.fantasy_team_id = s.team_id
    LEFT JOIN lineup_slots ls ON ls.fantasy_team_id = s.team_id AND ls.date = s.src AND ls.player_id = rp.player_id
    UNION ALL
    SELECT s.team_id, s.date, ls.player_id, ls.slot
    FROM src s
    JOIN lineup_slots ls ON ls.fantasy_team_id = s.team_id AND ls.date = s.date
    WHERE s.src = s.date AND s.date < $4::date
      AND NOT EXISTS (SELECT 1 FROM roster_players rp
                      WHERE rp.fantasy_team_id = s.team_id AND rp.player_id = ls.player_id)
  ),
  starters AS (SELECT team_id, date, player_id, slot FROM lineup WHERE slot NOT IN ${NON_SCORING})`;

const SUMS = `
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
         coalesce(sum(s.turnover), 0)::int AS tov`;

// Starters' games with minutes, one row per start (team, player, game), for
// the game limits to count in tip-off order. $5: one team id, or null for all.
const START = `st.team_id::int AS team_id, st.player_id::int AS player_id, st.slot,
         to_char(st.date, 'YYYY-MM-DD') AS date, g.id::int AS game_id,
         to_char(g.datetime AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS tipoff`;
const PLAYED_SQL = `
  WITH ${LINEUP_CTE}
  SELECT ${START}, 1 AS gp, coalesce(s.min, 0)::float8 AS min, ${SUMS}
  FROM starters st
  JOIN games g ON g.date = st.date AND g.game_type = 'regular'
  JOIN player_game_stats s ON s.game_id = g.id AND s.player_id = st.player_id AND s.min > 0
  -- Redundant with the join, but it lets the planner start from the week's games.
  WHERE g.date BETWEEN $2::date AND $3::date AND ($5::bigint IS NULL OR st.team_id = $5)
  GROUP BY st.team_id, st.player_id, st.slot, st.date, g.id, s.id`;

// Games not yet started, from $4 (today) on, for each day's starters' current
// NBA teams, one row per start. $5 as above. A game the provider hasn't marked
// started but that has his minutes is already in PLAYED_SQL, so it's left out.
const UPCOMING_SQL = `
  WITH ${LINEUP_CTE}
  SELECT ${START}
  FROM starters st
  JOIN players p ON p.id = st.player_id
  JOIN games g ON g.date = st.date AND p.team_id IN (g.home_team_id, g.visitor_team_id)
  WHERE st.date >= $4::date AND g.game_type = 'regular' AND NOT g.postponed
    AND coalesce(g.status_state, 'scheduled') = 'scheduled'
    AND NOT EXISTS (SELECT 1 FROM player_game_stats s WHERE s.game_id = g.id AND s.player_id = st.player_id AND s.min > 0)
    AND ($5::bigint IS NULL OR st.team_id = $5)`;

// $5 team ids, $6 a date in the week: each team's lineup that day, with each
// player's NBA game and stat line (whether or not he started).
const DAY_SQL = `
  WITH ${LINEUP_CTE}
  SELECT l.team_id::int AS team_id, l.player_id::int AS player_id, l.slot,
         g.id AS game_id, to_char(g.datetime AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS tipoff,
         g.status, g.status_state,
         coalesce(g.status_state <> 'scheduled' OR g.datetime <= now(), false) AS started,
         g.home_team_id = p.team_id AS home, opp.abbreviation AS opp_abbr,
         g.home_team_score AS home_score, g.visitor_team_score AS visitor_score,
         CASE WHEN s.min > 0 THEN 1 ELSE 0 END AS gp,
         CASE WHEN s.id IS NOT NULL THEN coalesce(s.min, 0)::float8 END AS min,
         coalesce(s.fgm, 0) AS fgm, coalesce(s.fga, 0) AS fga, coalesce(s.ftm, 0) AS ftm,
         coalesce(s.fta, 0) AS fta, coalesce(s.fg3m, 0) AS fg3m, coalesce(s.pts, 0) AS pts,
         coalesce(s.reb, 0) AS reb, coalesce(s.ast, 0) AS ast, coalesce(s.stl, 0) AS stl,
         coalesce(s.blk, 0) AS blk, coalesce(s.turnover, 0) AS tov
  FROM lineup l
  JOIN players p ON p.id = l.player_id
  LEFT JOIN LATERAL (
    SELECT * FROM games g
     WHERE g.date = l.date AND NOT g.postponed AND p.team_id IN (g.home_team_id, g.visitor_team_id)
     ORDER BY g.datetime LIMIT 1
  ) g ON true
  LEFT JOIN teams opp ON opp.id = CASE WHEN g.home_team_id = p.team_id THEN g.visitor_team_id ELSE g.home_team_id END
  LEFT JOIN player_game_stats s ON s.player_id = p.id AND s.game_id = g.id
  WHERE l.team_id = ANY($5) AND l.date = $6::date`;

// $5 team ids, $6 a date in the week: each team's lineup that day (the slots shown with week totals).
const SLOTS_SQL = `
  WITH ${LINEUP_CTE}
  SELECT team_id::int AS team_id, player_id::int AS player_id, slot
  FROM lineup WHERE team_id = ANY($5) AND date = $6::date`;

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

function addTotals(a: Totals, b: Totals): Totals {
  const out = { ...a };
  for (const k of Object.keys(out) as (keyof Totals)[]) out[k] += b[k];
  return out;
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

/** A week's game limits as stored (league_weeks.game_limits); null = none. */
export function toGameLimits(v: unknown): GameLimits | null {
  const parsed = parseGameLimits(v);
  return "limits" in parsed ? parsed.limits : null;
}

const toStart = (r: StartRow): Start => ({ slot: r.slot, date: r.date, tipoff: r.tipoff, gameId: r.game_id });

function byTeam<T extends { team_id: number }>(rows: T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const r of rows) out.set(r.team_id, [...(out.get(r.team_id) ?? []), r]);
  return out;
}

/** The starts that count under `limits`, summed per team and player. */
function countedRows(starts: PlayedStartRow[], limits: GameLimits | null): PlayedRow[] {
  const out = new Map<string, PlayedRow>();
  for (const rows of byTeam(starts).values()) {
    const outcomes = countStarts(rows.map(toStart), limits);
    rows.forEach((r, i) => {
      if (outcomes[i] !== "counted") return;
      const key = `${r.team_id}:${r.player_id}`;
      const prev = out.get(key);
      out.set(key, prev
        ? { ...addTotals(prev, r), team_id: r.team_id, player_id: r.player_id, min: prev.min + r.min }
        : { ...addTotals(ZERO, r), team_id: r.team_id, player_id: r.player_id, min: r.min });
    });
  }
  return [...out.values()];
}

/** Each team's starts still to tip off that will count under `limits`. */
function countedLeft(played: PlayedStartRow[], upcoming: StartRow[], limits: GameLimits | null): Map<number, number> {
  const playedByTeam = byTeam(played);
  const out = new Map<number, number>();
  for (const [team, rows] of byTeam(upcoming)) {
    const before = playedByTeam.get(team) ?? [];
    const outcomes = countStarts([...before, ...rows].map(toStart), limits);
    out.set(team, outcomes.slice(before.length).filter((o) => o === "counted").length);
  }
  return out;
}

async function weekLimits(db: Pool, leagueId: number, startsOn: string): Promise<GameLimits | null> {
  const { rows: [w] } = await db.query<{ game_limits: unknown }>(
    `SELECT game_limits FROM league_weeks WHERE league_id = $1 AND starts_on = $2::date`,
    [leagueId, startsOn],
  );
  return toGameLimits(w?.game_limits ?? null);
}

/** Each team's week totals for one league week, keyed by team id. Teams with no games are left out. */
export async function weekLines(
  db: Pool,
  leagueId: number,
  week: { startsOn: string; endsOn: string },
  today: string,
): Promise<Map<number, CategoryLine>> {
  const [{ rows: starts }, limits] = await Promise.all([
    db.query<PlayedStartRow>(PLAYED_SQL, [leagueId, week.startsOn, week.endsOn, today, null]),
    weekLimits(db, leagueId, week.startsOn),
  ]);
  const rows = countedRows(starts, limits);
  const totals = new Map<number, Totals>();
  for (const r of rows) totals.set(r.team_id, addTotals(totals.get(r.team_id) ?? ZERO, r));
  return new Map([...totals].map(([id, t]) => [id, weekLine(t)]));
}

/** A team's week line, or all zeros when it has no games yet. */
export const emptyLine = (): CategoryLine => weekLine(ZERO);

/**
 * One team's starters' games against its week's game limits (for My team):
 * games counted so far, what the lineups as set will reach, and the days whose
 * starts won't count. Null when the week has no limits.
 */
export async function teamGameLimitUsage(
  db: Pool,
  leagueId: number,
  teamId: number,
  week: { startsOn: string; endsOn: string },
  today: string,
): Promise<GameLimitUsage | null> {
  const limits = await weekLimits(db, leagueId, week.startsOn);
  if (!limits) return null;
  const params = [leagueId, week.startsOn, week.endsOn, today, teamId];
  const [played, upcoming] = await Promise.all([
    db.query<PlayedStartRow>(PLAYED_SQL, params),
    db.query<StartRow>(UPCOMING_SQL, params),
  ]);
  return gameLimitUsage(played.rows.map(toStart), upcoming.rows.map(toStart), limits);
}

interface TeamRow {
  id: number;
  name: string;
  manager_name: string | null;
  abbreviation: string;
  logo_updated_at: Date | null;
  owner_user_id: number | null;
}

interface WeekRow {
  week: number;
  starts_on: string;
  ends_on: string;
  is_playoffs: boolean;
  game_limits: unknown;
}

interface PlayerInfoRow {
  id: number;
  first_name: string;
  last_name: string;
  position: string | null;
  nba_person_id: number | null;
  team_abbr: string | null;
}

type PlayedRow = Totals & { team_id: number; player_id: number; min: number };

interface StartRow {
  team_id: number;
  player_id: number;
  slot: LineupSlot;
  date: string;
  game_id: number;
  tipoff: string | null;
}

type PlayedStartRow = StartRow & Totals & { min: number };

interface DayRow extends Totals {
  team_id: number;
  player_id: number;
  slot: LineupSlot;
  game_id: number | null;
  tipoff: string | null;
  status: string | null;
  status_state: string | null;
  started: boolean;
  home: boolean | null;
  opp_abbr: string | null;
  home_score: number | null;
  visitor_score: number | null;
  min: number | null;
}

function toGame(r: DayRow): LineupGame | null {
  if (r.game_id === null) return null;
  const state = r.status_state === "final" ? "final" : r.started ? "live" : "scheduled";
  const [team, opp] = r.home ? [r.home_score, r.visitor_score] : [r.visitor_score, r.home_score];
  return {
    opponentAbbr: r.opp_abbr ?? "",
    home: r.home ?? false,
    tipoff: r.tipoff,
    state,
    // Scheduled games carry their tip-off timestamp in `status` (see queries/lineup.ts).
    statusText: state === "live" && r.status && !/^\d{4}-\d{2}-\d{2}T/.test(r.status) ? r.status : null,
    teamScore: state === "scheduled" ? null : team,
    opponentScore: state === "scheduled" ? null : opp,
  };
}

const slotOrder = (s: LineupSlot | null) => (s === null ? LINEUP_SLOTS.length : LINEUP_SLOTS.indexOf(s));

/** Both teams' roster rows: that day's lineup and lines, or week totals from started games. */
async function loadPlayers(
  db: Pool,
  params: (number | string)[],
  teamIds: number[],
  statsDate: string | null,
  refDate: string,
  played: PlayedRow[],
): Promise<Map<number, MatchupPlayer[]>> {
  type Row = { teamId: number; playerId: number; slot: LineupSlot | null; game: LineupGame | null; stats: MatchupPlayer["stats"] };
  const rows: Row[] = [];
  if (statsDate) {
    const { rows: day } = await db.query<DayRow>(DAY_SQL, [...params, teamIds, statsDate]);
    for (const r of day) {
      rows.push({
        teamId: r.team_id, playerId: r.player_id, slot: r.slot, game: toGame(r),
        stats: r.min === null ? null : { ...weekLine(r), gp: r.gp, min: Math.round(r.min) },
      });
    }
  } else {
    const { rows: slots } = await db.query<{ team_id: number; player_id: number; slot: LineupSlot }>(
      SLOTS_SQL, [...params, teamIds, refDate],
    );
    const key = (t: number, p: number) => `${t}:${p}`;
    const byKey = new Map(played.filter((r) => teamIds.includes(r.team_id)).map((r) => [key(r.team_id, r.player_id), r]));
    const line = (r: PlayedRow | undefined) => (r ? { ...weekLine(r), gp: r.gp, min: Math.round(r.min) } : null);
    for (const s of slots) {
      rows.push({ teamId: s.team_id, playerId: s.player_id, slot: s.slot, game: null, stats: line(byKey.get(key(s.team_id, s.player_id))) });
      byKey.delete(key(s.team_id, s.player_id));
    }
    // Started earlier in the week but no longer on the roster.
    for (const r of byKey.values()) rows.push({ teamId: r.team_id, playerId: r.player_id, slot: null, game: null, stats: line(r) });
  }

  const { rows: info } = await db.query<PlayerInfoRow>(
    `SELECT p.id, p.first_name, p.last_name, nullif(p.position, '') AS position, p.nba_person_id,
            t.abbreviation AS team_abbr
     FROM players p LEFT JOIN teams t ON t.id = p.team_id
     WHERE p.id = ANY($1)`,
    [rows.map((r) => r.playerId)],
  );
  const infoById = new Map(info.map((p) => [p.id, p]));
  const out = new Map<number, MatchupPlayer[]>(teamIds.map((id) => [id, []]));
  for (const r of rows) {
    const p = infoById.get(r.playerId);
    if (!p) continue;
    out.get(r.teamId)!.push({
      id: p.id, firstName: p.first_name, lastName: p.last_name, teamAbbr: p.team_abbr,
      position: p.position, nbaPersonId: p.nba_person_id, slot: r.slot, game: r.game, stats: r.stats,
    });
  }
  for (const list of out.values()) {
    list.sort((a, b) => slotOrder(a.slot) - slotOrder(b.slot) || a.lastName.localeCompare(b.lastName));
  }
  return out;
}

export interface MatchupOptions {
  /** Show this team's matchup instead of the signed-in manager's. */
  teamId?: number | null;
  /** A date in the week for that day's stats, "week" for week totals; default today while live, else week. */
  stats?: string | null;
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
  opts: MatchupOptions = {},
): Promise<MatchupWeek | null> {
  const { rows: [league] } = await db.query<{
    id: number; today: string; time_zone: string; roster_slots: Partial<Record<LineupSlot, number>>;
    playoff_teams: number; toilet_bowl: boolean; toilet_bowl_teams: number;
  }>(
    `SELECT id::int, time_zone, roster_slots, playoff_teams, toilet_bowl, toilet_bowl_teams,
            to_char((now() AT TIME ZONE time_zone)::date, 'YYYY-MM-DD') AS today
     FROM leagues WHERE season = $1 ORDER BY id LIMIT 1`,
    [season],
  );
  if (!league) return null;
  const { today } = league;

  const { rows: weeks } = await db.query<WeekRow>(
    `SELECT week, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on, is_playoffs,
            game_limits
     FROM league_weeks WHERE league_id = $1 ORDER BY week`,
    [league.id],
  );
  if (weeks.length === 0) return null;
  const w =
    (week !== null && weeks.find((x) => x.week === week)) ||
    weeks.find((x) => today <= x.ends_on) ||
    weeks[weeks.length - 1];

  const { rows: teams } = await db.query<TeamRow>(
    `SELECT ft.id::int, ft.name, u.name AS manager_name, ft.abbreviation, ft.logo_updated_at, ft.owner_user_id::int
     FROM fantasy_teams ft LEFT JOIN users u ON u.id = ft.owner_user_id WHERE ft.league_id = $1`,
    [league.id],
  );
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const summary = (id: number): FantasyTeamSummary => {
    return toTeamSummary(teamById.get(id)!);
  };
  const mine = userId === null ? undefined : teams.find((t) => t.owner_user_id === userId);

  const status = today < w.starts_on ? "upcoming" : today > w.ends_on ? "final" : "live";
  const inWeek = (d: string) => d >= w.starts_on && d <= w.ends_on;
  const statsDate =
    opts.stats === "week" ? null
    : opts.stats && /^\d{4}-\d{2}-\d{2}$/.test(opts.stats) && inWeek(opts.stats) ? opts.stats
    : status === "live" ? today : null;
  const refDate = today < w.starts_on ? w.starts_on : today > w.ends_on ? w.ends_on : today;

  const params = [league.id, w.starts_on, w.ends_on, today];
  const limits = toGameLimits(w.game_limits);
  const [starts, upcoming, pairs] = await Promise.all([
    db.query<PlayedStartRow>(PLAYED_SQL, [...params, null]),
    db.query<StartRow>(UPCOMING_SQL, [...params, null]),
    db.query<Pick<BracketRow, "team_a_id" | "team_b_id" | "bracket" | "bracket_round">>(
      `SELECT team_a_id::int, team_b_id::int, bracket, bracket_round FROM matchups WHERE league_id = $1 AND week = $2
        ORDER BY bracket NULLS FIRST, bracket_round, bracket_slot, id`,
      [league.id, w.week],
    ),
  ]);
  const played = countedRows(starts.rows, limits);
  const totals = new Map<number, Totals>();
  for (const r of played) totals.set(r.team_id, addTotals(totals.get(r.team_id) ?? ZERO, r));
  const gamesLeft = countedLeft(starts.rows, upcoming.rows, limits);
  const line = (id: number) => weekLine(totals.get(id) ?? ZERO);
  const cfg = configOf({ ...league, team_count: teams.length });

  // The pairing to show: the requested team's, else the manager's. Byes have nothing to show.
  const involves = (p: { team_a_id: number; team_b_id: number | null }, id: number | undefined) =>
    id !== undefined && p.team_b_id !== null && (p.team_a_id === id || p.team_b_id === id);
  const focusId = opts.teamId != null && teamById.has(opts.teamId) ? opts.teamId : mine?.id;
  const shown = pairs.rows.find((p) => involves(p, focusId));

  let matchup: MatchupWeek["matchup"] = null;
  if (shown && shown.team_b_id !== null) {
    // The manager's team goes on the left when it plays; otherwise the team asked for.
    const leftId = involves(shown, mine?.id) ? mine!.id : focusId!;
    const rightId = shown.team_a_id === leftId ? shown.team_b_id : shown.team_a_id;
    const players = await loadPlayers(db, params, [leftId, rightId], statsDate, refDate, played);
    const side = (id: number): MatchupSide => ({
      ...summary(id), managerName: teamById.get(id)!.manager_name, stats: line(id), gamesPlayed: totals.get(id)?.gp ?? 0,
      gamesLeft: gamesLeft.get(id) ?? 0, players: players.get(id) ?? [], ...(limits && { gameLimit: limits.total }),
    });
    const team = side(leftId);
    const opponent = side(rightId);
    const bracket = bracketTag(shown, cfg);
    matchup = { team, opponent, ...compareLines(team.stats, opponent.stats), isMine: leftId === mine?.id, ...(bracket && { bracket }) };
  }

  const others: MatchupWeek["others"] = pairs.rows
    .filter((p) => p !== shown)
    .map((p) => {
      const bracket = bracketTag(p, cfg);
      return {
        teamA: summary(p.team_a_id),
        teamB: p.team_b_id === null ? null : summary(p.team_b_id),
        score: p.team_b_id === null ? { wins: 0, losses: 0, ties: 0 } : compareLines(line(p.team_a_id), line(p.team_b_id)).score,
        isMine: mine !== undefined && (p.team_a_id === mine.id || p.team_b_id === mine.id),
        ...(bracket && { bracket }),
      };
    });

  const dayMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  return {
    season,
    week: w.week,
    weekCount: weeks.length,
    startsOn: w.starts_on,
    endsOn: w.ends_on,
    isPlayoffs: w.is_playoffs,
    status,
    day: status === "live" ? (dayMs(today) - dayMs(w.starts_on)) / 86_400_000 + 1 : null,
    days: (dayMs(w.ends_on) - dayMs(w.starts_on)) / 86_400_000 + 1,
    today,
    timeZone: league.time_zone,
    slots: LINEUP_SLOTS.map((slot) => ({ slot, count: league.roster_slots[slot] ?? 0 })).filter((x) => x.count > 0),
    statsDate,
    matchup,
    myTeam: mine ? summary(mine.id) : null,
    others,
  };
}

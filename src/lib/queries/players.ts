// Season-averages queries behind GET /api/players and GET /api/players/:id.
// Aggregation happens in SQL; valuation (value.ts) and filtering run in TS on
// the ~500 aggregated rows of one season. The streaming filters' sets (teams
// with a scheduled game on the chosen days, players on waivers) come from SQL.
//
// Rules: games played = stat rows with min > 0 (DNP rows have min 0);
// only regular-season games count (games.game_type = 'regular': no playoffs,
// play-in or NBA Cup final); FG%/FT% = summed makes / summed attempts.
// Season totals and averages count finished games only (games.status_state =
// 'final'), so a game in progress doesn't move them; the game log shows it.
import type { Pool } from "pg";
import type {
  CategoryLine,
  GameLogRow,
  PlayDay,
  PlayerDetailResponse,
  PlayerOwner,
  PlayerRow,
  PlayerUpcomingGame,
  PlayersResponse,
  PlayersTeamOption,
  SeasonRow,
  SortKey,
  StatMode,
} from "../types";
import { nameMatches, positionMatches, type PlayersQuery } from "./params";
import { valuePlayers, type SeasonTotals } from "./value";
import { playDates, streamDates, clearsByTomorrow } from "./streaming";
import { ISO, getWaiverStatus } from "./waiverStatus";
import { getInjuries } from "./injuries";
import { getWatchedIds } from "./watchlist";

// Shared aggregate columns. All casts make pg return JS numbers, not strings.
const AGG = `
  count(*)::int                      AS gp,
  coalesce(sum(s.min), 0)::float8    AS min,
  coalesce(sum(s.fgm), 0)::int       AS fgm,
  coalesce(sum(s.fga), 0)::int       AS fga,
  coalesce(sum(s.ftm), 0)::int       AS ftm,
  coalesce(sum(s.fta), 0)::int       AS fta,
  coalesce(sum(s.fg3m), 0)::int      AS fg3m,
  coalesce(sum(s.pts), 0)::int       AS pts,
  coalesce(sum(s.reb), 0)::int       AS reb,
  coalesce(sum(s.ast), 0)::int       AS ast,
  coalesce(sum(s.stl), 0)::int       AS stl,
  coalesce(sum(s.blk), 0)::int       AS blk,
  coalesce(sum(s.turnover), 0)::int  AS tov`;

const SEASON_TOTALS_SQL = `
  WITH t AS (
    SELECT s.player_id, ${AGG}
    FROM player_game_stats s
    JOIN games g ON g.id = s.game_id AND g.game_type = 'regular'
    WHERE s.season = $1 AND s.min > 0 AND g.status_state = 'final' AND ($2::date IS NULL OR g.date >= $2::date)
    GROUP BY s.player_id
  )
  SELECT t.*, p.first_name, p.last_name, nullif(p.position, '') AS position,
         p.nba_person_id, p.team_id, tm.abbreviation AS team_abbr
  FROM t
  JOIN players p ON p.id = t.player_id
  LEFT JOIN teams tm ON tm.id = p.team_id`;

export interface TotalsRow {
  player_id: number;
  gp: number;
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

interface SeasonPlayerRow extends TotalsRow {
  first_name: string;
  last_name: string;
  position: string | null;
  nba_person_id: number | null;
  team_id: number | null;
  team_abbr: string | null;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const pct = (makes: number, attempts: number) => (attempts > 0 ? r3(makes / attempts) : null);

function toTotals(r: TotalsRow): SeasonTotals {
  return {
    playerId: r.player_id, gp: r.gp, min: r.min,
    fgm: r.fgm, fga: r.fga, ftm: r.ftm, fta: r.fta, fg3m: r.fg3m,
    pts: r.pts, reb: r.reb, ast: r.ast, stl: r.stl, blk: r.blk, tov: r.tov,
  };
}

/** Category line for a mode. Percentages always come from totals. */
export function categoryLine(t: TotalsRow, mode: StatMode): CategoryLine & { min: number } {
  const per = mode === "avg" && t.gp > 0 ? (x: number) => r1(x / t.gp) : (x: number) => x;
  return {
    min: mode === "avg" && t.gp > 0 ? r1(t.min / t.gp) : r1(t.min),
    fgm: per(t.fgm), fga: per(t.fga), fgPct: pct(t.fgm, t.fga),
    ftm: per(t.ftm), fta: per(t.fta), ftPct: pct(t.ftm, t.fta),
    fg3m: per(t.fg3m), pts: per(t.pts), reb: per(t.reb), ast: per(t.ast),
    stl: per(t.stl), blk: per(t.blk), tov: per(t.tov),
  };
}

// The last-14-days window ends at today, or at the season's last played game
// for a finished season, so past seasons get their final two weeks.
const LAST14_WINDOW_SQL = `
  SELECT to_char(d - 13, 'YYYY-MM-DD') AS "from", to_char(d, 'YYYY-MM-DD') AS "to"
  FROM (
    SELECT least(current_date, max(g.date)) AS d
    FROM games g
    WHERE g.season = $1 AND g.game_type = 'regular'
      AND EXISTS (SELECT 1 FROM player_game_stats s WHERE s.game_id = g.id AND s.min > 0)
  ) x
  WHERE d IS NOT NULL`;

// Players on a team in the season's league (one league per season; the newest wins), and the team.
const ROSTERED_SQL = `
  SELECT rp.player_id, ft.id::int AS team_id, ft.abbreviation
  FROM roster_players rp
  JOIN fantasy_teams ft ON ft.id = rp.fantasy_team_id
  WHERE rp.league_id = (SELECT id FROM leagues WHERE season = $1 ORDER BY id DESC LIMIT 1)`;

/** The team filters' choices: the season league's fantasy teams and the NBA's teams, by name. */
async function getTeamOptions(db: Pool, season: number): Promise<PlayersResponse["teamOptions"]> {
  const [fantasy, nba] = await Promise.all([
    db.query<PlayersTeamOption>(
      `SELECT id::int, abbreviation, name FROM fantasy_teams
        WHERE league_id = (SELECT id FROM leagues WHERE season = $1 ORDER BY id DESC LIMIT 1)
        ORDER BY name`,
      [season],
    ),
    db.query<PlayersTeamOption>(`SELECT id, abbreviation, coalesce(full_name, abbreviation) AS name FROM teams ORDER BY name`),
  ]);
  return { fantasy: fantasy.rows, nba: nba.rows };
}

export async function getOwners(db: Pool, season: number): Promise<Map<number, PlayerOwner>> {
  const { rows } = await db.query<{ player_id: number; team_id: number; abbreviation: string }>(ROSTERED_SQL, [season]);
  return new Map(rows.map((r) => [r.player_id, { teamId: r.team_id, abbreviation: r.abbreviation }]));
}

// Each team's scheduled games on the given dates: not started, not finished, not postponed.
const UPCOMING_GAMES_SQL = `
  SELECT to_char(g.date, 'YYYY-MM-DD') AS date, t.team_id, t.home, opp.abbreviation AS opponent_abbr,
         ${ISO("g.datetime")} AS tipoff
  FROM games g
  CROSS JOIN LATERAL (VALUES (g.home_team_id, g.visitor_team_id, true),
                             (g.visitor_team_id, g.home_team_id, false)) t(team_id, opp_id, home)
  LEFT JOIN teams opp ON opp.id = t.opp_id
  WHERE g.date = ANY($1::date[]) AND g.status_state = 'scheduled' AND NOT g.postponed
    AND (g.datetime IS NULL OR g.datetime > now()) AND t.team_id IS NOT NULL
  ORDER BY g.date, g.datetime NULLS LAST, g.id`;

async function getUpcomingGames(
  db: Pool, days: PlayDay[], dates: Record<PlayDay, string>,
): Promise<Map<number, PlayerUpcomingGame[]>> {
  const byTeam = new Map<number, PlayerUpcomingGame[]>();
  if (days.length === 0) return byTeam;
  const dayOf = new Map(days.map((d) => [dates[d], d]));
  const { rows } = await db.query<{ date: string; team_id: number; home: boolean; opponent_abbr: string | null; tipoff: string | null }>(
    UPCOMING_GAMES_SQL, [playDates(days, dates)],
  );
  for (const r of rows) {
    const list = byTeam.get(r.team_id) ?? [];
    list.push({ day: dayOf.get(r.date)!, date: r.date, opponentAbbr: r.opponent_abbr ?? "", home: r.home, tipoff: r.tipoff });
    byTeam.set(r.team_id, list);
  }
  return byTeam;
}

/** Sort key for a column (not "value"), from unrounded numbers in the requested mode. */
export function sortKeyFn(sort: SortKey, mode: StatMode): (r: SeasonPlayerRow) => number | string | null {
  const per = (x: number, gp: number) => (mode === "avg" && gp > 0 ? x / gp : x);
  switch (sort) {
    case "name":
      return (r) => `${r.last_name} ${r.first_name}`;
    case "gp":
      return (r) => r.gp;
    case "fgPct":
      return (r) => (r.fga > 0 ? r.fgm / r.fga : null);
    case "ftPct":
      return (r) => (r.fta > 0 ? r.ftm / r.fta : null);
    case "value":
      throw new Error("value is sorted by the valuation, not a row column");
    default:
      return (r) => per(r[sort], r.gp);
  }
}

/** Season totals (finished regular-season games) for every player with a game in `season`. */
export async function getSeasonTotals(db: Pool, season: number): Promise<SeasonTotals[]> {
  const { rows } = await db.query<SeasonPlayerRow>(SEASON_TOTALS_SQL, [season, null]);
  return rows.map(toTotals);
}

/** Season totals and 9CAT valuation for every player with a regular-season game in `season`. */
export async function getSeasonValues(
  db: Pool,
  season: number,
): Promise<Map<number, { totals: TotalsRow; value: number }>> {
  const { rows } = await db.query<SeasonPlayerRow>(SEASON_TOTALS_SQL, [season, null]);
  const values = valuePlayers(rows.map(toTotals));
  return new Map(rows.map((r) => [r.player_id, { totals: r, value: values.get(r.player_id)!.value }]));
}

/** `userId`: the signed-in user, for the stars and scope=watch (which lists nothing signed out); null = signed out. */
export async function getPlayers(db: Pool, q: PlayersQuery, userId: number | null): Promise<PlayersResponse> {
  let window: { from: string; to: string } | null = null;
  if (q.range === "last14") {
    const res = await db.query<{ from: string; to: string }>(LAST14_WINDOW_SQL, [q.season]);
    window = res.rows[0] ?? null;
  }
  // No played games yet: a null bound returns no rows for last14 either way.
  const [{ rows }, owners, waivers, injuries, teamOptions, watched] = await Promise.all([
    db.query<SeasonPlayerRow>(SEASON_TOTALS_SQL, [q.season, window?.from ?? null]),
    getOwners(db, q.season),
    getWaiverStatus(db, q.season),
    getInjuries(db),
    getTeamOptions(db, q.season),
    getWatchedIds(db, userId),
  ]);
  // Value and rank over every player with a game in the range, before scope/q/pos, with the request's punt weights.
  const values = valuePlayers(rows.map(toTotals), q.weights);

  // Streaming filters, in the league's time zone.
  const now = new Date();
  const dates = streamDates(now, waivers.timeZone);
  const upcoming = await getUpcomingGames(db, q.plays, dates);
  const onWaivers = (id: number) => !owners.has(id) && waivers.players.has(id);

  const key = q.sort === "value" ? null : sortKeyFn(q.sort, q.mode);
  const sign = q.dir === "asc" ? 1 : -1;
  const matching = rows
    .filter((r) => q.scope === "all" || (q.scope === "fa" ? !owners.has(r.player_id) : watched.has(r.player_id)))
    .filter((r) => q.team === null || owners.get(r.player_id)?.teamId === q.team)
    .filter((r) => q.nba === null || r.team_abbr === q.nba)
    .filter((r) => positionMatches(q.pos, r.position) && nameMatches(q.q, r.first_name, r.last_name))
    .filter((r) => q.plays.length === 0 || (r.team_id !== null && upcoming.has(r.team_id)))
    .filter((r) =>
      q.waivers === "any" ? true
      : q.waivers === "on" ? onWaivers(r.player_id)
      : onWaivers(r.player_id) && clearsByTomorrow(waivers.players.get(r.player_id)!.clearsAt, waivers.timeZone, now))
    .map((r) => {
      const v = values.get(r.player_id)!;
      return { r, v, k: key ? key(r) : v.value };
    })
    .sort((a, b) => {
      // Missing values (FG%/FT% with no attempts) go last in either direction.
      if (a.k === null || b.k === null) return a.k === null ? (b.k === null ? a.v.rank - b.v.rank : 1) : -1;
      if (typeof a.k === "string") return sign * a.k.localeCompare(b.k as string) || a.v.rank - b.v.rank;
      return sign * (a.k - (b.k as number)) || a.v.rank - b.v.rank;
    });

  const start = (q.page - 1) * q.perPage;
  const players: PlayerRow[] = matching.slice(start, start + q.perPage).map(({ r, v }) => {
    const { min, ...stats } = categoryLine(r, q.mode);
    return {
      id: r.player_id,
      firstName: r.first_name,
      lastName: r.last_name,
      teamAbbr: r.team_abbr,
      position: r.position,
      nbaPersonId: r.nba_person_id,
      rank: v.rank,
      gp: r.gp,
      min,
      stats,
      value: Math.round(v.value * 100) / 100,
      owner: owners.get(r.player_id) ?? null,
      waiver: waivers.players.get(r.player_id) ?? null,
      games: (r.team_id !== null && upcoming.get(r.team_id)) || [],
      injury: injuries.get(r.player_id) ?? null,
      watched: userId === null ? null : watched.has(r.player_id),
    };
  });

  return {
    season: q.season,
    range: q.range,
    sort: q.sort,
    dir: q.dir,
    from: window?.from ?? null,
    to: window?.to ?? null,
    mode: q.mode,
    scope: q.scope,
    plays: q.plays,
    playDates: dates,
    waivers: q.waivers,
    team: q.team,
    nba: q.nba,
    teamOptions,
    weights: q.weights,
    page: q.page,
    perPage: q.perPage,
    total: matching.length,
    players,
    timeZone: waivers.timeZone,
  };
}

function seasonRow(season: number, t: TotalsRow): SeasonRow {
  return { season, gp: t.gp, ...categoryLine(t, "avg") };
}

/** Everything but `thisWeek`, which comes from the league (getPlayerWeek in ./lineup).
 *  Returns null when the player id does not exist. */
export async function getPlayerDetail(
  db: Pool, playerId: number, season: number, userId: number | null,
): Promise<Omit<PlayerDetailResponse, "thisWeek" | "transactions"> | null> {
  const [playerRes, seasonsRes, logRes, owners, waivers, injuries, watched] = await Promise.all([
    db.query<{
      id: number; first_name: string; last_name: string; position: string | null;
      nba_person_id: number | null; team_abbr: string | null; team_name: string | null;
    }>(
      `SELECT p.id, p.first_name, p.last_name, nullif(p.position, '') AS position, p.nba_person_id,
              tm.abbreviation AS team_abbr, tm.full_name AS team_name
       FROM players p LEFT JOIN teams tm ON tm.id = p.team_id
       WHERE p.id = $1`,
      [playerId],
    ),
    db.query<TotalsRow & { season: number }>(
      `SELECT s.season, s.player_id, ${AGG}
       FROM player_game_stats s
       JOIN games g ON g.id = s.game_id AND g.game_type = 'regular'
       WHERE s.player_id = $1 AND s.season <= $2 AND s.min > 0 AND g.status_state = 'final'
       GROUP BY s.season, s.player_id
       ORDER BY s.season DESC`,
      [playerId, season],
    ),
    db.query<{
      game_id: number; date: string; home: boolean; opponent_abbr: string | null; result: "W" | "L" | null;
      min: number; fgm: number; fga: number; ftm: number; fta: number; fg3m: number;
      pts: number; reb: number; ast: number; stl: number; blk: number; tov: number;
    }>(
      `SELECT g.id AS game_id, to_char(g.date, 'YYYY-MM-DD') AS date,
              coalesce(s.team_id = g.home_team_id, false) AS home,
              opp.abbreviation AS opponent_abbr,
              CASE WHEN lower(g.status) LIKE 'final%'
                        AND g.home_team_score IS NOT NULL AND g.visitor_team_score IS NOT NULL
                        AND g.home_team_score <> g.visitor_team_score
                   THEN CASE WHEN (g.home_team_score > g.visitor_team_score) = (s.team_id = g.home_team_id)
                             THEN 'W' ELSE 'L' END
              END AS result,
              s.min::float8 AS min,
              coalesce(s.fgm, 0) AS fgm, coalesce(s.fga, 0) AS fga,
              coalesce(s.ftm, 0) AS ftm, coalesce(s.fta, 0) AS fta,
              coalesce(s.fg3m, 0) AS fg3m, coalesce(s.pts, 0) AS pts,
              coalesce(s.reb, 0) AS reb, coalesce(s.ast, 0) AS ast,
              coalesce(s.stl, 0) AS stl, coalesce(s.blk, 0) AS blk,
              coalesce(s.turnover, 0) AS tov
       FROM player_game_stats s
       JOIN games g ON g.id = s.game_id AND g.game_type = 'regular'
       LEFT JOIN teams opp ON opp.id = CASE WHEN s.team_id = g.home_team_id
                                            THEN g.visitor_team_id ELSE g.home_team_id END
       WHERE s.player_id = $1 AND s.season = $2 AND s.min > 0
       ORDER BY g.date DESC, g.id DESC`,
      [playerId, season],
    ),
    getOwners(db, season),
    getWaiverStatus(db, season),
    getInjuries(db, [playerId]),
    getWatchedIds(db, userId, [playerId]),
  ]);

  const p = playerRes.rows[0];
  if (!p) return null;

  const current = seasonsRes.rows.find((r) => r.season === season);
  const gameLog: GameLogRow[] = logRes.rows.map((r) => ({
    gameId: r.game_id,
    date: r.date,
    opponentAbbr: r.opponent_abbr ?? "",
    home: r.home,
    result: r.result,
    min: r1(r.min),
    fgm: r.fgm, fga: r.fga, ftm: r.ftm, fta: r.fta, fg3m: r.fg3m,
    pts: r.pts, reb: r.reb, ast: r.ast, stl: r.stl, blk: r.blk, tov: r.tov,
  }));

  return {
    player: {
      id: p.id,
      firstName: p.first_name,
      lastName: p.last_name,
      teamAbbr: p.team_abbr,
      position: p.position,
      nbaPersonId: p.nba_person_id,
      teamName: p.team_name,
      injury: injuries.get(p.id) ?? null,
    },
    owner: owners.get(p.id) ?? null,
    waiver: waivers.players.get(p.id) ?? null,
    timeZone: waivers.timeZone,
    season,
    seasonAverages: current ? seasonRow(season, current) : null,
    gameLog,
    pastSeasons: seasonsRes.rows.filter((r) => r.season < season).map((r) => seasonRow(r.season, r)),
    watched: userId === null ? null : watched.has(p.id),
  };
}

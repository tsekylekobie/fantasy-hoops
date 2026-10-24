// Season-averages queries behind GET /api/players and GET /api/players/:id.
// Aggregation happens in SQL; valuation (value.ts) and filtering run in TS on
// the ~500 aggregated rows of one season.
//
// Rules: games played = stat rows with min > 0 (DNP rows have min 0);
// only regular-season games count (games.game_type = 'regular': no playoffs,
// play-in or NBA Cup final); FG%/FT% = summed makes / summed attempts.
import type { Pool } from "pg";
import type {
  CategoryLine,
  GameLogRow,
  PlayerDetailResponse,
  PlayerRow,
  PlayersResponse,
  SeasonRow,
  StatMode,
} from "../types";
import { nameMatches, positionMatches, type PlayersQuery } from "./params";
import { valuePlayers, type SeasonTotals } from "./value";

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
    WHERE s.season = $1 AND s.min > 0
    GROUP BY s.player_id
  )
  SELECT t.*, p.first_name, p.last_name, nullif(p.position, '') AS position,
         p.nba_person_id, tm.abbreviation AS team_abbr
  FROM t
  JOIN players p ON p.id = t.player_id
  LEFT JOIN teams tm ON tm.id = p.team_id`;

interface TotalsRow {
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

export async function getPlayers(db: Pool, q: PlayersQuery): Promise<PlayersResponse> {
  const { rows } = await db.query<SeasonPlayerRow>(SEASON_TOTALS_SQL, [q.season]);
  // Value and rank over every player with a game this season, before q/pos.
  const values = valuePlayers(rows.map(toTotals));

  const matching = rows
    .filter((r) => positionMatches(q.pos, r.position) && nameMatches(q.q, r.first_name, r.last_name))
    .map((r) => ({ r, v: values.get(r.player_id)! }))
    .sort((a, b) => a.v.rank - b.v.rank);

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
    };
  });

  return { season: q.season, mode: q.mode, page: q.page, perPage: q.perPage, total: matching.length, players };
}

function seasonRow(season: number, t: TotalsRow): SeasonRow {
  return { season, gp: t.gp, ...categoryLine(t, "avg") };
}

/** Returns null when the player id does not exist. */
export async function getPlayerDetail(db: Pool, playerId: number, season: number): Promise<PlayerDetailResponse | null> {
  const [playerRes, seasonsRes, logRes] = await Promise.all([
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
       WHERE s.player_id = $1 AND s.season <= $2 AND s.min > 0
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
      availability: null,
    },
    season,
    seasonAverages: current ? seasonRow(season, current) : null,
    gameLog,
    pastSeasons: seasonsRes.rows.filter((r) => r.season < season).map((r) => seasonRow(r.season, r)),
  };
}

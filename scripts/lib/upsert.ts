// Bulk upserts from the provider-neutral client types into Postgres.
// Each function takes one JSON parameter and expands it with
// jsonb_to_recordset, so a page of 100 rows is a single statement.

import type { PoolClient, Pool } from "pg";
import type { Game, Injury, Player, StatLine, Team } from "../../src/lib/bdl";

type Db = Pool | PoolClient;

/** Upsert teams (full update). */
export async function upsertTeams(db: Db, teams: Team[]): Promise<number> {
  if (!teams.length) return 0;
  const rows = teams.map((t) => ({
    id: t.id,
    abbreviation: t.abbreviation,
    city: t.city,
    name: t.name,
    full_name: t.fullName,
    conference: t.conference,
    division: t.division,
    raw: t.raw,
  }));
  const res = await db.query(
    `INSERT INTO teams (id, abbreviation, city, name, full_name, conference, division, raw, updated_at)
     SELECT id, abbreviation, city, name, full_name, conference, division, raw, now()
     FROM jsonb_to_recordset($1::jsonb) AS r(id int, abbreviation text, city text, name text,
       full_name text, conference text, division text, raw jsonb)
     ON CONFLICT (id) DO UPDATE SET
       abbreviation = EXCLUDED.abbreviation, city = EXCLUDED.city, name = EXCLUDED.name,
       full_name = EXCLUDED.full_name, conference = EXCLUDED.conference,
       division = EXCLUDED.division, raw = EXCLUDED.raw, updated_at = now()`,
    [JSON.stringify(rows)],
  );
  return res.rowCount ?? 0;
}

/** Insert current-franchise teams we don't have yet; never overwrites. */
export async function ensureTeams(db: Db, teams: Team[]): Promise<void> {
  const current = dedupe(teams.filter((t) => t.isCurrent), (t) => t.id);
  if (!current.length) return;
  await db.query(
    `INSERT INTO teams (id, abbreviation, city, name, full_name, conference, division, raw)
     SELECT id, abbreviation, city, name, full_name, conference, division, raw
     FROM jsonb_to_recordset($1::jsonb) AS r(id int, abbreviation text, city text, name text,
       full_name text, conference text, division text, raw jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      JSON.stringify(
        current.map((t) => ({
          id: t.id,
          abbreviation: t.abbreviation,
          city: t.city,
          name: t.name,
          full_name: t.fullName,
          conference: t.conference,
          division: t.division,
          raw: t.raw,
        })),
      ),
    ],
  );
}

function playerRows(players: Player[]) {
  return dedupe(players, (p) => p.id).map((p) => ({
    id: p.id,
    first_name: p.firstName,
    last_name: p.lastName,
    position: p.position,
    team_id: p.teamId,
    jersey_number: p.jerseyNumber,
    raw: p.raw,
  }));
}

// team_id is kept only when it references a team we store (the 30 current
// franchises); defunct franchises and free agents become null.
const PLAYER_SELECT = `
  SELECT r.id, r.first_name, r.last_name, r.position,
         (SELECT t.id FROM teams t WHERE t.id = r.team_id), r.jersey_number, r.raw, now()
  FROM jsonb_to_recordset($1::jsonb) AS r(id int, first_name text, last_name text,
    position text, team_id int, jersey_number text, raw jsonb)`;

/** Upsert players (full update). Never touches nba_person_id. */
export async function upsertPlayers(db: Db, players: Player[]): Promise<number> {
  if (!players.length) return 0;
  const res = await db.query(
    `INSERT INTO players (id, first_name, last_name, position, team_id, jersey_number, raw, updated_at)
     ${PLAYER_SELECT}
     ON CONFLICT (id) DO UPDATE SET
       first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
       position = EXCLUDED.position, team_id = EXCLUDED.team_id,
       jersey_number = EXCLUDED.jersey_number, raw = EXCLUDED.raw, updated_at = now()`,
    [JSON.stringify(playerRows(players))],
  );
  return res.rowCount ?? 0;
}

/** Insert players we don't have yet; existing rows are left alone. */
export async function ensurePlayers(db: Db, players: Player[]): Promise<number> {
  if (!players.length) return 0;
  const res = await db.query(
    `INSERT INTO players (id, first_name, last_name, position, team_id, jersey_number, raw, updated_at)
     ${PLAYER_SELECT}
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(playerRows(players))],
  );
  return res.rowCount ?? 0;
}

/** Upsert games (full update). Team ids we don't store (non-NBA opponents) become null. */
export async function upsertGames(db: Db, games: Game[]): Promise<number> {
  if (!games.length) return 0;
  const rows = dedupe(games, (g) => g.id).map((g) => ({
    id: g.id,
    date: g.date,
    season: g.season,
    status: g.status,
    status_state: g.statusState,
    period: g.period,
    time: g.time,
    postseason: g.postseason,
    postponed: g.postponed,
    datetime: g.datetime,
    home_team_id: g.homeTeamId,
    visitor_team_id: g.visitorTeamId,
    home_team_score: g.homeTeamScore,
    visitor_team_score: g.visitorTeamScore,
    raw: g.raw,
  }));
  const res = await db.query(
    `INSERT INTO games (id, date, season, status, status_state, period, time, postseason, postponed,
       datetime, home_team_id, visitor_team_id, home_team_score, visitor_team_score, raw, game_type,
       updated_at)
     SELECT id, date, season, status, status_state, period, time, postseason, postponed,
       datetime, (SELECT t.id FROM teams t WHERE t.id = r.home_team_id),
       (SELECT t.id FROM teams t WHERE t.id = r.visitor_team_id),
       home_team_score, visitor_team_score, raw,
       CASE WHEN postseason THEN 'playoffs'
            WHEN raw->>'ist_stage' = 'Championship' THEN 'cup_final'
            ELSE 'regular' END,
       now()
     FROM jsonb_to_recordset($1::jsonb) AS r(id int, date date, season int, status text,
       status_state text, period int, time text, postseason boolean, postponed boolean,
       datetime timestamptz, home_team_id int, visitor_team_id int, home_team_score int,
       visitor_team_score int, raw jsonb)
     ON CONFLICT (id) DO UPDATE SET
       date = EXCLUDED.date, season = EXCLUDED.season, status = EXCLUDED.status,
       status_state = EXCLUDED.status_state, period = EXCLUDED.period, time = EXCLUDED.time,
       postseason = EXCLUDED.postseason, postponed = EXCLUDED.postponed,
       datetime = EXCLUDED.datetime, home_team_id = EXCLUDED.home_team_id,
       visitor_team_id = EXCLUDED.visitor_team_id, home_team_score = EXCLUDED.home_team_score,
       visitor_team_score = EXCLUDED.visitor_team_score, raw = EXCLUDED.raw,
       -- play_in is only detectable across a season (classifyGames); keep it.
       game_type = CASE WHEN games.game_type = 'play_in' AND EXCLUDED.game_type = 'regular'
                        THEN 'play_in' ELSE EXCLUDED.game_type END,
       updated_at = now()`,
    [JSON.stringify(rows)],
  );
  return res.rowCount ?? 0;
}

/**
 * Upsert stat lines. Referenced teams/players/games are inserted first if
 * missing (games are upserted, since the nested game is just as fresh).
 * Call inside a transaction.
 */
export async function upsertStatLines(db: Db, lines: StatLine[]): Promise<number> {
  if (!lines.length) return 0;
  await ensureTeams(db, lines.flatMap((l) => (l.team ? [l.team] : [])));
  await ensurePlayers(db, lines.map((l) => l.player));
  await upsertGames(db, lines.map((l) => l.game));
  // Two rows for the same (player, game) can't go in one INSERT; keep the last.
  const rows = dedupe(lines, (l) => `${l.playerId}:${l.gameId}`).map((l) => ({
    id: l.id,
    player_id: l.playerId,
    game_id: l.gameId,
    team_id: l.teamId,
    season: l.season,
    postseason: l.postseason,
    min: l.min,
    fgm: l.fgm, fga: l.fga, fg3m: l.fg3m, fg3a: l.fg3a, ftm: l.ftm, fta: l.fta,
    oreb: l.oreb, dreb: l.dreb, reb: l.reb, ast: l.ast, stl: l.stl, blk: l.blk,
    turnover: l.turnover, pf: l.pf, pts: l.pts, plus_minus: l.plusMinus,
    raw: l.raw,
  }));
  // Conflict target is (player_id, game_id): a stat id could in principle be
  // reissued for the same line, and that pair is what the app keys on.
  const res = await db.query(
    `INSERT INTO player_game_stats (id, player_id, game_id, team_id, season, postseason, min,
       fgm, fga, fg3m, fg3a, ftm, fta, oreb, dreb, reb, ast, stl, blk, turnover, pf, pts,
       plus_minus, raw, regular_season, updated_at)
     SELECT id, player_id, game_id, (SELECT t.id FROM teams t WHERE t.id = r.team_id), season,
       postseason, min, fgm, fga, fg3m, fg3a, ftm, fta, oreb, dreb, reb, ast, stl, blk,
       turnover, pf, pts, plus_minus, raw,
       (SELECT g.game_type = 'regular' FROM games g WHERE g.id = r.game_id), now()
     FROM jsonb_to_recordset($1::jsonb) AS r(id int, player_id int, game_id int, team_id int,
       season int, postseason boolean, min numeric, fgm int, fga int, fg3m int, fg3a int,
       ftm int, fta int, oreb int, dreb int, reb int, ast int, stl int, blk int, turnover int,
       pf int, pts int, plus_minus int, raw jsonb)
     ON CONFLICT (player_id, game_id) DO UPDATE SET
       id = EXCLUDED.id, team_id = EXCLUDED.team_id, season = EXCLUDED.season,
       postseason = EXCLUDED.postseason, min = EXCLUDED.min,
       fgm = EXCLUDED.fgm, fga = EXCLUDED.fga, fg3m = EXCLUDED.fg3m, fg3a = EXCLUDED.fg3a,
       ftm = EXCLUDED.ftm, fta = EXCLUDED.fta, oreb = EXCLUDED.oreb, dreb = EXCLUDED.dreb,
       reb = EXCLUDED.reb, ast = EXCLUDED.ast, stl = EXCLUDED.stl, blk = EXCLUDED.blk,
       turnover = EXCLUDED.turnover, pf = EXCLUDED.pf, pts = EXCLUDED.pts,
       plus_minus = EXCLUDED.plus_minus, raw = EXCLUDED.raw,
       regular_season = EXCLUDED.regular_season, updated_at = now()`,
    [JSON.stringify(rows)],
  );
  return res.rowCount ?? 0;
}

/**
 * Set games.game_type for a season and mirror it into
 * player_game_stats.regular_season. Play-in games are flagged
 * postseason=false by the provider; we detect them as non-postseason games
 * played after both teams already had 82 regular-season games.
 */
export async function classifyGames(db: Db, season: number): Promise<{ playIn: number; cupFinal: number }> {
  await db.query(
    `UPDATE games SET game_type = CASE WHEN postseason THEN 'playoffs'
                                       WHEN raw->>'ist_stage' = 'Championship' THEN 'cup_final'
                                       ELSE 'regular' END
     WHERE season = $1`,
    [season],
  );
  await db.query(
    `WITH team_games AS (
       SELECT g.id, t.team_id,
              row_number() OVER (PARTITION BY t.team_id ORDER BY g.date, g.datetime, g.id) AS n
       FROM games g
       CROSS JOIN LATERAL (VALUES (g.home_team_id), (g.visitor_team_id)) AS t(team_id)
       WHERE g.season = $1 AND g.game_type = 'regular' AND NOT g.postponed
     ),
     play_in AS (
       SELECT id FROM team_games GROUP BY id HAVING min(n) > 82
     )
     UPDATE games SET game_type = 'play_in' WHERE id IN (SELECT id FROM play_in)`,
    [season],
  );
  // Older seasons (2023, 2024) have no ist_stage, so the Cup final can't be
  // spotted directly. After play-in removal its two teams are the only ones
  // with 83 regular games; the final is their mid-December meeting.
  await db.query(
    `WITH team_counts AS (
       SELECT t.team_id, count(*) AS n
       FROM games g
       CROSS JOIN LATERAL (VALUES (g.home_team_id), (g.visitor_team_id)) AS t(team_id)
       WHERE g.season = $1 AND g.game_type = 'regular' AND NOT g.postponed
       GROUP BY t.team_id
     ),
     finalists AS (SELECT team_id FROM team_counts WHERE n = 83),
     candidates AS (
       SELECT g.id FROM games g
       WHERE g.season = $1 AND g.game_type = 'regular'
         AND g.home_team_id IN (SELECT team_id FROM finalists)
         AND g.visitor_team_id IN (SELECT team_id FROM finalists)
         AND extract(month FROM g.date) = 12 AND extract(day FROM g.date) BETWEEN 7 AND 20
     )
     UPDATE games SET game_type = 'cup_final'
     WHERE id IN (SELECT id FROM candidates)
       AND (SELECT count(*) FROM finalists) = 2
       AND (SELECT count(*) FROM candidates) = 1
       AND NOT EXISTS (SELECT 1 FROM games WHERE season = $1 AND game_type = 'cup_final')`,
    [season],
  );
  await db.query(
    `UPDATE player_game_stats s SET regular_season = (g.game_type = 'regular')
     FROM games g
     WHERE g.id = s.game_id AND s.season = $1
       AND s.regular_season IS DISTINCT FROM (g.game_type = 'regular')`,
    [season],
  );
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE game_type = 'play_in')::int AS play_in,
            count(*) FILTER (WHERE game_type = 'cup_final')::int AS cup_final
     FROM games WHERE season = $1`,
    [season],
  );
  return { playIn: rows[0].play_in, cupFinal: rows[0].cup_final };
}

/**
 * Appends to player_injuries (a history: the latest row per player is his
 * current report) only where the report changed. "Available" is stored as a
 * NULL status, the same as leaving the report; players on the last report
 * but missing from this one get a NULL row. An empty report is ignored
 * rather than clearing everyone. Call inside a transaction.
 */
export async function recordInjuries(db: Db, report: Injury[]): Promise<number> {
  if (!report.length) return 0;
  await ensurePlayers(db, report.map((i) => i.player));
  const rows = dedupe(report, (i) => i.playerId).map((i) => ({
    player_id: i.playerId,
    status: i.status === "Available" ? null : i.status,
    return_date: i.returnDate,
    description: i.description,
    raw: i.raw,
  }));
  const res = await db.query(
    `WITH latest AS (
       SELECT DISTINCT ON (player_id) player_id, status, return_date, description
         FROM player_injuries ORDER BY player_id, observed_at DESC, id DESC
     ),
     feed AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb)
         AS r(player_id int, status text, return_date date, description text, raw jsonb)
     ),
     changed AS (
       SELECT f.player_id, f.status, f.return_date, f.description, f.raw
         FROM feed f LEFT JOIN latest l ON l.player_id = f.player_id
        WHERE (l.player_id IS NULL AND f.status IS NOT NULL)
           OR (l.player_id IS NOT NULL AND (l.status, l.return_date, l.description)
                 IS DISTINCT FROM (f.status, f.return_date, f.description))
     ),
     dropped AS (
       SELECT l.player_id, NULL::text, NULL::date, NULL::text, NULL::jsonb
         FROM latest l
        WHERE l.status IS NOT NULL AND NOT EXISTS (SELECT 1 FROM feed f WHERE f.player_id = l.player_id)
     )
     INSERT INTO player_injuries (player_id, status, return_date, description, raw)
     SELECT * FROM changed UNION ALL SELECT * FROM dropped`,
    [JSON.stringify(rows)],
  );
  return res.rowCount ?? 0;
}

function dedupe<T>(items: T[], key: (t: T) => string | number): T[] {
  const map = new Map<string | number, T>();
  for (const item of items) map.set(key(item), item);
  return [...map.values()];
}

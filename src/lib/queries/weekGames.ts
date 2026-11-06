// Each player's NBA games in a matchup week: the "2/4" chip on My team and the Players page.
import type { Pool, PoolClient } from "pg";

type Db = Pool | PoolClient;

export interface WeekGames {
  /** Not yet tipped off. */
  remaining: number;
  total: number;
}

// Whether game `g` has started: the provider says so, or the clock has passed
// tip-off (so stale data locks early, never late).
export const started = (g: string) => `coalesce(${g}.status_state <> 'scheduled' OR ${g}.datetime <= now(), false)`;

/**
 * Each player's NBA team's games from `start` to `end` (inclusive): those not
 * yet tipped off, and in all. A game counts as played once it has started.
 * Each day uses his team that day (player_team_on), so a week he was traded in
 * counts his old team's games before the trade and his new team's after.
 */
export async function getWeekGames(db: Db, ids: number[], start: string, end: string): Promise<Map<number, WeekGames>> {
  if (ids.length === 0) return new Map();
  const { rows } = await db.query<{ id: number; total: number; remaining: number }>(
    `SELECT p.id, count(g.id)::int AS total, count(g.id) FILTER (WHERE NOT ${started("g")})::int AS remaining
       FROM players p
       CROSS JOIN generate_series($2::date, $3::date, interval '1 day') d
       CROSS JOIN LATERAL (SELECT player_team_on(p.id, d::date) AS team_id OFFSET 0) pt
       LEFT JOIN games g ON g.date = d::date AND NOT g.postponed
                        AND pt.team_id IN (g.home_team_id, g.visitor_team_id)
      WHERE p.id = ANY($1)
      GROUP BY p.id`,
    [ids, start, end],
  );
  return new Map(rows.map((r) => [r.id, { remaining: r.remaining, total: r.total }]));
}

export interface CurrentWeek {
  week: number;
  /** Inclusive ISO dates (yyyy-mm-dd). */
  startsOn: string;
  endsOn: string;
  isPlayoffs: boolean;
  /** The league's IANA time zone. */
  timeZone: string;
}

/** `season`'s league's current matchup week (the one containing the league's today); null outside the schedule. */
export async function getCurrentWeek(db: Db, season: number): Promise<CurrentWeek | null> {
  const { rows: [w] } = await db.query<{
    week: number; starts_on: string; ends_on: string; is_playoffs: boolean; time_zone: string;
  }>(
    `SELECT lw.week, to_char(lw.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(lw.ends_on, 'YYYY-MM-DD') AS ends_on,
            lw.is_playoffs, l.time_zone
       FROM leagues l JOIN league_weeks lw ON lw.league_id = l.id
      WHERE l.season = $1 AND (now() AT TIME ZONE l.time_zone)::date BETWEEN lw.starts_on AND lw.ends_on
      ORDER BY l.id DESC
      LIMIT 1`,
    [season],
  );
  return w
    ? { week: w.week, startsOn: w.starts_on, endsOn: w.ends_on, isPlayoffs: w.is_playoffs, timeZone: w.time_zone }
    : null;
}

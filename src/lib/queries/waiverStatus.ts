// Who's on waivers, for the Players table and the player modal (and the
// league's waiver settings, shared with queries/waivers.ts). Kept apart from
// waivers.ts so players.ts can use it without importing the roster-move code.
import type { Pool, PoolClient } from "pg";
import type { PlayerWaiver, WaiverOrder } from "../types";

type Db = Pool | PoolClient;

export const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

export interface WaiverLeague {
  id: number;
  season: number;
  type: WaiverOrder["type"];
  timeZone: string;
  waiverTime: string;
  waiverDays: number;
  waiversAfterGameStart: boolean;
  nextRunAt: string;
}

export async function getWaiverLeague(db: Db, where: { season: number } | { leagueId: number }): Promise<WaiverLeague | null> {
  const bySeason = "season" in where;
  const { rows: [r] } = await db.query<{
    id: number; season: number; waiver_type: WaiverOrder["type"]; time_zone: string; waiver_time: string;
    waiver_days: number; waivers_after_game_start: boolean; next_run_at: string;
  }>(
    `SELECT id::int, season, waiver_type, time_zone, to_char(waiver_time, 'HH24:MI') AS waiver_time, waiver_days,
            waivers_after_game_start, ${ISO("next_waiver_run(id, now())")} AS next_run_at
       FROM leagues WHERE ${bySeason ? "season" : "id"} = $1 ORDER BY id DESC LIMIT 1`,
    [bySeason ? where.season : where.leagueId],
  );
  if (!r) return null;
  return {
    id: r.id, season: r.season, type: r.waiver_type, timeZone: r.time_zone, waiverTime: r.waiver_time,
    waiverDays: r.waiver_days, waiversAfterGameStart: r.waivers_after_game_start, nextRunAt: r.next_run_at,
  };
}

/**
 * Free agents on waivers in the season's league, by player id: recently
 * dropped players, plus (waivers_after_game_start) free agents whose game
 * today has tipped off. For the Players table and the player modal.
 */
export async function getWaiverStatus(db: Pool, season: number): Promise<{ timeZone: string; players: Map<number, PlayerWaiver> }> {
  const league = await getWaiverLeague(db, { season });
  const players = new Map<number, PlayerWaiver>();
  if (!league) return { timeZone: "America/New_York", players };
  const { rows } = await db.query<{
    player_id: number; clears_at: string; reason: PlayerWaiver["reason"];
    team_id: number | null; name: string | null; abbreviation: string | null;
  }>(
    `SELECT w.player_id, ${ISO("w.clears_at")} AS clears_at, 'dropped' AS reason, ft.id::int AS team_id, ft.name, ft.abbreviation
       FROM waiver_players w LEFT JOIN fantasy_teams ft ON ft.id = w.dropped_by_team_id
      WHERE w.league_id = $1
     UNION ALL
     SELECT p.id, ${ISO("next_waiver_run($1, now())")}, 'game_started', NULL, NULL, NULL
       FROM players p
      WHERE $2
        AND EXISTS (SELECT 1 FROM games g
                     WHERE g.date = (now() AT TIME ZONE $3)::date AND NOT g.postponed
                       AND p.team_id IN (g.home_team_id, g.visitor_team_id)
                       AND coalesce(g.status_state <> 'scheduled' OR g.datetime <= now(), false))
        AND NOT EXISTS (SELECT 1 FROM roster_players rp WHERE rp.league_id = $1 AND rp.player_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM waiver_players w WHERE w.league_id = $1 AND w.player_id = p.id)`,
    [league.id, league.waiversAfterGameStart, league.timeZone],
  );
  for (const r of rows) {
    players.set(r.player_id, {
      clearsAt: r.clears_at,
      reason: r.reason,
      droppedBy: r.team_id === null ? null : { id: r.team_id, name: r.name!, abbreviation: r.abbreviation! },
    });
  }
  return { timeZone: league.timeZone, players };
}

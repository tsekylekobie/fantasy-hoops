// Whether a game a page shows is in progress right now, so the page knows when
// to poll for new numbers (components/live): no live game, no countdown and no
// polling. A game is live once the provider says so or its tip-off has passed
// (the provider can be slow to flip it), until it's final, as in the worker's
// live task (scripts/worker.ts). The worker keeps syncing finished games for a
// few hours (final stat lines can lag the buzzer); a page picks those up on its
// next load rather than polling with nothing live.
import type { Pool } from "pg";

export interface LiveScope {
  /** Only games on this date (yyyy-mm-dd). */
  date?: string;
  /** Only games these players play in (their NBA team on the game's date, player_team_on)… */
  playerIds?: number[];
  /** …or any player on this league's rosters plays in. */
  leagueId?: number;
}

export async function gamesInProgress(db: Pool, scope: LiveScope = {}): Promise<boolean> {
  const byPlayers = scope.playerIds !== undefined || scope.leagueId !== undefined;
  const { rows: [r] } = await db.query<{ live: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM games g
        WHERE NOT g.postponed
          AND g.date >= (now() - interval '1 day')::date
          AND coalesce(g.status_state, '') <> 'final'
          AND (coalesce(g.status_state, 'scheduled') <> 'scheduled' OR g.datetime <= now())
          AND ($1::date IS NULL OR g.date = $1::date)
          AND (NOT $2::boolean OR EXISTS (
                SELECT 1
                  FROM (SELECT unnest($3::int[]) AS id
                        UNION
                        SELECT rp.player_id::int FROM roster_players rp
                          JOIN fantasy_teams ft ON ft.id = rp.fantasy_team_id
                         WHERE ft.league_id = $4::bigint) p
                  CROSS JOIN LATERAL (SELECT player_team_on(p.id, g.date) AS team_id OFFSET 0) pt
                 WHERE pt.team_id IN (g.home_team_id, g.visitor_team_id)))
     ) AS live`,
    [scope.date ?? null, byPlayers, scope.playerIds ?? [], scope.leagueId ?? null],
  );
  return r.live;
}

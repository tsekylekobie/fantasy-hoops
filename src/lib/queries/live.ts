// Whether stats can still change right now, so pages know when to poll for
// new numbers (components/live). Mirrors the worker's live task
// (scripts/worker.ts): a game is live once the provider says so or its tip-off
// has passed, until it's final; finished games stay "live" a little longer
// because the provider's final stat lines can lag the buzzer.
import type { Pool } from "pg";

const RECENT_FINAL_HOURS = 3;

export async function gamesInProgress(db: Pool): Promise<boolean> {
  const { rows: [r] } = await db.query<{ live: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM games g
        WHERE NOT g.postponed
          AND g.date >= (now() - interval '1 day')::date
          AND (coalesce(g.status_state, '') <> 'final'
                 AND (coalesce(g.status_state, 'scheduled') <> 'scheduled' OR g.datetime <= now())
               OR g.status_state = 'final' AND g.datetime > now() - make_interval(hours => $1))
     ) AS live`,
    [RECENT_FINAL_HOURS],
  );
  return r.live;
}

// The League page's waiver order (fantasy_teams.waiver_priority, which the
// Yahoo sync keeps; in reverse_standings leagues, worst record first) and the
// league's waiver rules. Display only: claims and the waiver run are Yahoo's.
import type { Pool } from "pg";
import type { WaiverOrder } from "../types";
import { getLeagueOverview } from "./league";
import { toTeamSummary, type TeamRow } from "./teamLogo";
import { getWaiverLeague, type WaiverLeague } from "./waiverStatus";
/** Team ids in waiver order, first claim first. */
async function waiverOrder(pool: Pool, league: WaiverLeague): Promise<number[]> {
  const { rows } = await pool.query<{ id: number; waiver_priority: number | null }>(
    `SELECT id::int, waiver_priority FROM fantasy_teams WHERE league_id = $1 ORDER BY waiver_priority NULLS LAST, id`,
    [league.id],
  );
  const ids = rows.map((r) => r.id);
  if (league.type !== "reverse_standings") return ids;
  const overview = await getLeagueOverview(pool, league.season, null);
  if (!overview) return ids;
  // Standings are best first; ties keep waiver_priority order (stable sort).
  const place = new Map(overview.standings.map((s) => [s.id, s.rank]));
  return [...ids].sort((a, b) => (place.get(b) ?? 0) - (place.get(a) ?? 0));
}

/** The League page's waiver order and rules; null when there's no league. */
export async function getWaiverOrder(pool: Pool, season: number): Promise<WaiverOrder | null> {
  const league = await getWaiverLeague(pool, { season });
  if (!league) return null;
  const [order, { rows: teams }] = await Promise.all([
    waiverOrder(pool, league),
    pool.query<TeamRow & { faab_balance: number }>(
      `SELECT ft.id::int, ft.name, ft.abbreviation, ft.logo_updated_at,
              coalesce(ft.faab_balance, $2) AS faab_balance
         FROM fantasy_teams ft WHERE ft.league_id = $1`,
      [league.id, league.faabBudget],
    ),
  ]);
  const byId = new Map(teams.map((t) => [t.id, t]));
  return {
    type: league.type,
    timeZone: league.timeZone,
    waiverTime: league.waiverTime,
    waiverDaysOfWeek: league.waiverDaysOfWeek,
    waiverDays: league.waiverDays,
    waiversAfterGameStart: league.waiversAfterGameStart,
    allAddsByClaim: league.allAddsByClaim,
    nextRunAt: league.nextRunAt,
    faabBudget: league.faabBudget,
    faabMinBid: league.faabMinBid,
    teams: order.map((id, i) => {
      const t = byId.get(id)!;
      return {
        ...toTeamSummary(t), priority: i + 1,
        faabBalance: league.type === "faab" ? t.faab_balance : null,
      };
    }),
  };
}


// Any team in a league, for read-only views (/team/[id]).
import type { Pool } from "pg";
import type { SlotCounts } from "../lineup/rules";
import type { TeamContext } from "./lineup";

/** Team `teamId` in `season`'s league, with its owner; null if there's no such team. */
export async function getTeamById(
  db: Pool,
  teamId: number,
  season: number,
): Promise<(TeamContext & { ownerUserId: number | null }) | null> {
  const { rows: [r] } = await db.query<{
    team_name: string; abbreviation: string; waiver_priority: number | null; owner_user_id: number | null;
    league_id: number; league_name: string; season: number; roster_slots: SlotCounts;
    lineup_lock: "game_time" | "first_game"; il_statuses: string[]; il_plus_statuses: string[];
    il_min_days: number; il_plus_min_days: number; today: string;
  }>(
    `SELECT ft.name AS team_name, ft.abbreviation, ft.waiver_priority, ft.owner_user_id::int,
            l.id::int AS league_id, l.name AS league_name, l.season, l.roster_slots, l.lineup_lock,
            l.il_statuses, l.il_plus_statuses, l.il_min_days, l.il_plus_min_days,
            to_char((now() AT TIME ZONE l.time_zone)::date, 'YYYY-MM-DD') AS today
       FROM fantasy_teams ft JOIN leagues l ON l.id = ft.league_id
      WHERE ft.id = $1 AND l.season = $2`,
    [teamId, season],
  );
  if (!r) return null;
  return {
    teamId, teamName: r.team_name, abbreviation: r.abbreviation, waiverPriority: r.waiver_priority,
    ownerUserId: r.owner_user_id, leagueId: r.league_id, leagueName: r.league_name, season: r.season,
    rosterSlots: r.roster_slots, lineupLock: r.lineup_lock, ilStatuses: r.il_statuses,
    ilPlusStatuses: r.il_plus_statuses, ilMinDays: r.il_min_days, ilPlusMinDays: r.il_plus_min_days, today: r.today,
  };
}

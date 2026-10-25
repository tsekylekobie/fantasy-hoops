// Waivers: who's on them, the daily waiver run, and managers' pending claims.
//
// A claim is a 'waiver_claim' transaction (status pending) placed by
// runRosterMove when transactions/policy.ts says the add must wait. Its
// transaction_players rows are written when it's placed: the add (from NULL,
// to the team) and an optional drop (from the team, to NULL). process_at is
// the run that decides it: when the player's waivers clear, or the next run
// for a player on waivers only because his game started.
//
// The run happens daily at leagues.waiver_time in leagues.time_zone (the
// worker's waivers task; next_waiver_run/last_waiver_run in migration 0007).
// It takes every claim due by then and repeatedly gives the first team in the
// waiver order its best-ranked remaining claim (claim_rank). Each claim is
// re-checked against the roster as it is now (completeClaim), so a claim whose
// drop is gone, whose roster is full, or that hits the adds limit fails with a
// reason and the team's next claim is tried. When a claim wins, the other due
// claims for that player fail, and with continual rolling waivers the winning
// team moves to the back of the order. Then players whose waivers ended are
// cleared to free agents.
//
// Waiver order (leagues.waiver_type):
//   continual_rolling  fantasy_teams.waiver_priority; a won claim goes to the back.
//   reverse_standings  worst record first (ties: waiver_priority); winning doesn't move you.
//   faab               bidding isn't built yet; treated as continual_rolling.
import type { Pool, PoolClient } from "pg";
import type { SlotCounts } from "../lineup/rules";
import type {
  FantasyTeamSummary,
  MyClaimsResponse,
  PlayerSummary,
  WaiverClaim,
  WaiverOrder,
} from "../types";
import { getLeagueOverview } from "./league";
import { LineupError, loadValues, withTeamLock, type TeamContext } from "./lineup";
import { completeClaim } from "./transactions";
import { ISO, getWaiverLeague, type WaiverLeague } from "./waiverStatus";

// Any constant (paired with the league id); keeps two waiver runs from overlapping.
const RUN_LOCK = 727_031_007;

type Db = Pool | PoolClient;

/** Same as getUserTeam (queries/lineup.ts), by team id: the run acts for teams, not signed-in users. */
async function getTeamContext(db: Db, teamId: number): Promise<TeamContext | null> {
  const { rows: [r] } = await db.query<{
    team_name: string; manager_name: string | null; abbreviation: string; waiver_priority: number | null;
    league_id: string; league_name: string; season: number; roster_slots: SlotCounts;
    lineup_lock: "game_time" | "first_game"; il_statuses: string[]; il_plus_statuses: string[];
    il_min_days: number; il_plus_min_days: number; today: string;
  }>(
    `SELECT ft.name AS team_name, u.name AS manager_name, ft.abbreviation, ft.waiver_priority,
            l.id AS league_id, l.name AS league_name, l.season, l.roster_slots, l.lineup_lock,
            l.il_statuses, l.il_plus_statuses, l.il_min_days, l.il_plus_min_days,
            to_char((now() AT TIME ZONE l.time_zone)::date, 'YYYY-MM-DD') AS today
       FROM fantasy_teams ft JOIN leagues l ON l.id = ft.league_id
       LEFT JOIN users u ON u.id = ft.owner_user_id
      WHERE ft.id = $1`,
    [teamId],
  );
  if (!r) return null;
  return {
    teamId, teamName: r.team_name, managerName: r.manager_name, abbreviation: r.abbreviation,
    waiverPriority: r.waiver_priority, leagueId: Number(r.league_id), leagueName: r.league_name,
    season: r.season, rosterSlots: r.roster_slots, lineupLock: r.lineup_lock,
    ilStatuses: r.il_statuses, ilPlusStatuses: r.il_plus_statuses, ilMinDays: r.il_min_days,
    ilPlusMinDays: r.il_plus_min_days, today: r.today,
  };
}


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
    pool.query<FantasyTeamSummary & { pending: number }>(
      `SELECT ft.id::int, ft.name, ft.abbreviation,
              (SELECT count(*)::int FROM transactions t
                WHERE t.team_id = ft.id AND t.type = 'waiver_claim' AND t.status = 'pending') AS pending
         FROM fantasy_teams ft WHERE ft.league_id = $1`,
      [league.id],
    ),
  ]);
  const byId = new Map(teams.map((t) => [t.id, t]));
  return {
    type: league.type,
    timeZone: league.timeZone,
    waiverTime: league.waiverTime,
    waiverDays: league.waiverDays,
    waiversAfterGameStart: league.waiversAfterGameStart,
    nextRunAt: league.nextRunAt,
    teams: order.map((id, i) => {
      const t = byId.get(id)!;
      return { id: t.id, name: t.name, abbreviation: t.abbreviation, priority: i + 1, pendingClaims: t.pending };
    }),
  };
}

// --- The waiver run ---

interface DueClaim {
  id: number;
  teamId: number;
  rank: number;
  addPlayerId: number;
  addName: string;
  dropPlayerId: number | null;
}

export interface WaiverRunSummary {
  leagueId: number;
  asOf: string;
  claims: number;
  won: number;
  failed: number;
  cleared: number;
  /** One line per claim, in the order they were decided. */
  log: string[];
}

async function failClaim(db: Db, id: number, reason: string): Promise<void> {
  await db.query(
    `UPDATE transactions SET status = 'failed', processed_at = now(), failure_reason = $2 WHERE id = $1 AND status = 'pending'`,
    [id, reason],
  );
}

/**
 * Processes every claim due by `asOf` and clears players whose waivers end by
 * then. `scheduled`: this is the daily run for `asOf` (one of last_waiver_run's
 * times), recorded so it happens once; returns null if it already ran.
 * Otherwise it's a manual run (testing, or a commissioner running waivers early).
 */
export async function processWaivers(
  pool: Pool, leagueId: number, asOf: Date, opts: { scheduled: boolean },
): Promise<WaiverRunSummary | null> {
  const lock = await pool.connect();
  try {
    await lock.query(`SELECT pg_advisory_lock($1, $2)`, [RUN_LOCK, leagueId]);
    const { rows: [run] } = await pool.query<{ id: string }>(
      `INSERT INTO waiver_runs (league_id, scheduled, run_at, as_of) VALUES ($1, $2, CASE WHEN $2 THEN $3 ELSE now() END, $3)
       ON CONFLICT (league_id, run_at) WHERE scheduled DO NOTHING RETURNING id`,
      [leagueId, opts.scheduled, asOf],
    );
    if (!run) return null;

    const league = (await getWaiverLeague(pool, { leagueId }))!;
    // Taken now, so players dropped by this run's own claims stay on waivers
    // even when a manual run processes as of a later time.
    const { rows: clearing } = await pool.query<{ player_id: number }>(
      `SELECT player_id FROM waiver_players WHERE league_id = $1 AND clears_at <= $2`,
      [leagueId, asOf],
    );
    const values = await loadValues(pool, league.season);
    const { rows } = await pool.query<{
      id: number; team_id: number; claim_rank: number | null; add_id: number; add_name: string; drop_id: number | null;
    }>(
      `SELECT t.id::int, t.team_id::int, t.claim_rank, a.player_id AS add_id,
              trim(p.first_name || ' ' || p.last_name) AS add_name, d.player_id AS drop_id
         FROM transactions t
         JOIN transaction_players a ON a.transaction_id = t.id AND a.to_team_id IS NOT NULL
         JOIN players p ON p.id = a.player_id
         LEFT JOIN transaction_players d ON d.transaction_id = t.id AND d.to_team_id IS NULL
        WHERE t.league_id = $1 AND t.type = 'waiver_claim' AND t.status = 'pending' AND t.process_at <= $2
        ORDER BY t.claim_rank NULLS LAST, t.id`,
      [leagueId, asOf],
    );
    const due: DueClaim[] = rows.map((r) => ({
      id: r.id, teamId: r.team_id, rank: r.claim_rank ?? Number.MAX_SAFE_INTEGER,
      addPlayerId: r.add_id, addName: r.add_name, dropPlayerId: r.drop_id,
    }));

    const summary: WaiverRunSummary = { leagueId, asOf: asOf.toISOString(), claims: due.length, won: 0, failed: 0, cleared: 0, log: [] };
    const teams = new Map<number, TeamContext>();
    const abbr = async (teamId: number) => {
      if (!teams.has(teamId)) teams.set(teamId, (await getTeamContext(pool, teamId))!);
      return teams.get(teamId)!;
    };
    const rolling = league.type !== "reverse_standings";
    let order = await waiverOrder(pool, league);
    const open = new Set(due.map((c) => c.id));

    while (open.size > 0) {
      // The first team in the order with a claim left, and its best-ranked claim.
      let claim: DueClaim | undefined;
      for (const teamId of order) {
        claim = due.filter((c) => open.has(c.id) && c.teamId === teamId).sort((a, b) => a.rank - b.rank || a.id - b.id)[0];
        if (claim) break;
      }
      // Teams missing from the order (shouldn't happen) go last.
      claim ??= due.find((c) => open.has(c.id))!;
      open.delete(claim.id);
      const team = await abbr(claim.teamId);

      const winner = claim;
      const reason = await completeClaim(pool, team, values, winner, async (db) => {
        if (!rolling) return;
        const next = [...order.filter((id) => id !== winner.teamId), winner.teamId];
        await db.query(
          `UPDATE fantasy_teams ft SET waiver_priority = o.ord
             FROM unnest($1::bigint[]) WITH ORDINALITY AS o(id, ord) WHERE ft.id = o.id`,
          [next],
        );
      });
      if (reason !== null) {
        await failClaim(pool, claim.id, reason);
        summary.failed++;
        summary.log.push(`${team.abbreviation} ${claim.addName}: failed (${reason})`);
        continue;
      }
      summary.won++;
      summary.log.push(`${team.abbreviation} ${claim.addName}: won${claim.dropPlayerId ? ` (dropped #${claim.dropPlayerId})` : ""}`);
      if (rolling) order = [...order.filter((id) => id !== winner.teamId), winner.teamId];
      for (const lost of due.filter((c) => open.has(c.id) && c.addPlayerId === winner.addPlayerId)) {
        open.delete(lost.id);
        const loser = await abbr(lost.teamId);
        await failClaim(pool, lost.id, `${claim.addName} went to ${team.abbreviation}, ahead of you in the waiver order.`);
        summary.failed++;
        summary.log.push(`${loser.abbreviation} ${lost.addName}: lost to ${team.abbreviation}`);
      }
    }

    const cleared = await pool.query(
      `DELETE FROM waiver_players WHERE league_id = $1 AND clears_at <= $2 AND player_id = ANY($3::int[])`,
      [leagueId, asOf, clearing.map((r) => r.player_id)],
    );
    summary.cleared = cleared.rowCount ?? 0;
    await pool.query(
      `UPDATE waiver_runs SET finished_at = now(), claims = $2, won = $3, failed = $4, cleared = $5 WHERE id = $1`,
      [run.id, summary.claims, summary.won, summary.failed, summary.cleared],
    );
    return summary;
  } finally {
    await lock.query(`SELECT pg_advisory_unlock($1, $2)`, [RUN_LOCK, leagueId]).catch(() => {});
    lock.release();
  }
}

/**
 * The worker's waivers task: runs the season league's latest scheduled run if
 * it hasn't happened yet. Returns the run (null if it already ran) and when
 * the next one is due.
 */
export async function processDueWaivers(pool: Pool, season: number): Promise<{ run: WaiverRunSummary | null; nextRunAt: Date | null }> {
  const { rows: [l] } = await pool.query<{ id: number; last_run: Date; next_run: Date }>(
    `SELECT id::int, last_waiver_run(id, now()) AS last_run, next_waiver_run(id, now()) AS next_run
       FROM leagues WHERE season = $1 ORDER BY id DESC LIMIT 1`,
    [season],
  );
  if (!l) return { run: null, nextRunAt: null };
  const run = await processWaivers(pool, l.id, l.last_run, { scheduled: true });
  return { run, nextRunAt: l.next_run };
}

/** `at` for a manual run: "now", "next" (the next scheduled run time), or an ISO timestamp. */
export async function resolveRunTime(pool: Pool, leagueId: number, at: string): Promise<Date | null> {
  if (at === "now") return new Date();
  if (at === "next") {
    const { rows: [r] } = await pool.query<{ t: Date }>(`SELECT next_waiver_run($1, now()) AS t`, [leagueId]);
    return r?.t ?? null;
  }
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

// --- A manager's claims ---

interface ClaimRow {
  id: number;
  status: WaiverClaim["status"];
  claim_rank: number | null;
  process_at: string;
  processed_at: string | null;
  failure_reason: string | null;
  created_at: string;
  player_id: number;
  first_name: string;
  last_name: string;
  position: string | null;
  nba_person_id: number | null;
  team_abbr: string | null;
  is_add: boolean;
}

/** The team's pending claims (rank order) and the ones processed or cancelled in the last 7 days. */
export async function getMyClaims(pool: Pool, team: TeamContext): Promise<MyClaimsResponse> {
  const [league, { rows }] = await Promise.all([
    getWaiverLeague(pool, { leagueId: team.leagueId }),
    pool.query<ClaimRow>(
      `SELECT t.id::int, t.status, t.claim_rank, ${ISO("t.process_at")} AS process_at,
              ${ISO("t.processed_at")} AS processed_at, t.failure_reason, ${ISO("t.created_at")} AS created_at,
              p.id AS player_id, p.first_name, p.last_name, nullif(p.position, '') AS position, p.nba_person_id,
              nt.abbreviation AS team_abbr, tp.to_team_id IS NOT NULL AS is_add
         FROM transactions t
         JOIN transaction_players tp ON tp.transaction_id = t.id
         JOIN players p ON p.id = tp.player_id
         LEFT JOIN teams nt ON nt.id = p.team_id
        WHERE t.team_id = $1 AND t.type = 'waiver_claim'
          AND (t.status = 'pending' OR t.processed_at > now() - interval '7 days')
        ORDER BY t.id`,
      [team.teamId],
    ),
  ]);
  const { rows: [tc] } = await pool.query<{ n: number; priority: number | null }>(
    `SELECT (SELECT count(*)::int FROM fantasy_teams WHERE league_id = $1) AS n,
            (SELECT waiver_priority FROM fantasy_teams WHERE id = $2) AS priority`,
    [team.leagueId, team.teamId],
  );

  const claims = new Map<number, WaiverClaim>();
  for (const r of rows) {
    const player: PlayerSummary = {
      id: r.player_id, firstName: r.first_name, lastName: r.last_name, teamAbbr: r.team_abbr,
      position: r.position, nbaPersonId: r.nba_person_id,
    };
    let c = claims.get(r.id);
    if (!c) {
      c = {
        id: r.id, status: r.status, rank: r.status === "pending" ? r.claim_rank : null,
        add: player, drop: null, processAt: r.process_at, processedAt: r.processed_at,
        failureReason: r.failure_reason, createdAt: r.created_at,
      };
      claims.set(r.id, c);
    }
    if (r.is_add) c.add = player;
    else c.drop = player;
  }
  const all = [...claims.values()];
  return {
    timeZone: league!.timeZone,
    waiverTime: league!.waiverTime,
    nextRunAt: league!.nextRunAt,
    waiverPriority: tc.priority,
    teamCount: tc.n,
    pending: all.filter((c) => c.status === "pending").sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.id - b.id),
    recent: all.filter((c) => c.status !== "pending").sort((a, b) => (b.processedAt ?? "").localeCompare(a.processedAt ?? "") || b.id - a.id),
  };
}

/** Sets the team's claim order; `order` must list every pending claim exactly once. */
export async function reorderClaims(pool: Pool, team: TeamContext, order: number[]): Promise<void> {
  await withTeamLock(pool, team.teamId, async (db) => {
    const { rows } = await db.query<{ id: number }>(
      `SELECT id::int FROM transactions WHERE team_id = $1 AND type = 'waiver_claim' AND status = 'pending'`,
      [team.teamId],
    );
    const ids = new Set(rows.map((r) => r.id));
    if (order.length !== ids.size || new Set(order).size !== order.length || !order.every((id) => ids.has(id))) {
      throw new LineupError("Your claims changed; reload and try again.", 409);
    }
    await db.query(
      `UPDATE transactions t SET claim_rank = o.ord FROM unnest($2::bigint[]) WITH ORDINALITY AS o(id, ord)
        WHERE t.id = o.id AND t.team_id = $1`,
      [team.teamId, order],
    );
  });
}

/** Cancels one of the team's pending claims. */
export async function cancelClaim(pool: Pool, team: TeamContext, claimId: number): Promise<void> {
  await withTeamLock(pool, team.teamId, async (db) => {
    const { rowCount } = await db.query(
      `UPDATE transactions SET status = 'cancelled', processed_at = now()
        WHERE id = $1 AND team_id = $2 AND type = 'waiver_claim' AND status = 'pending'`,
      [claimId, team.teamId],
    );
    if (rowCount === 0) throw new LineupError("That claim isn't pending anymore.", 404);
  });
}

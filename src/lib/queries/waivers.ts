// Waivers: who's on them, the daily waiver run, and managers' pending claims.
//
// A claim is a 'waiver_claim' transaction (status pending) placed by
// runRosterMove when transactions/policy.ts says the add must wait. Its
// transaction_players rows are written when it's placed: the add (from NULL,
// to the team) and an optional drop (from the team, to NULL). process_at is
// the run that decides it: when the player's waivers clear, or the next run
// for a player on waivers only because his game started.
//
// The run happens at leagues.waiver_time in leagues.time_zone on the league's
// waiver_days_of_week (the worker's waivers task; next_waiver_run /
// last_waiver_run, migrations 0007 and 0009).
// It takes every claim due by then and decides them one at a time
// (resolveClaims, a pure function with the DB work passed in). Each claim is
// re-checked against the roster as it is now (completeClaim), so a claim whose
// drop is gone, whose roster is full, or that hits the adds limit fails with a
// reason and the next claim is tried. When a claim wins, the other due claims
// for that player fail. Then players whose waivers ended are cleared to free
// agents.
//
// Which claim goes next (leagues.waiver_type):
//   continual_rolling  the first team in fantasy_teams.waiver_priority order with a
//                      claim left, its best-ranked claim (claim_rank); a win moves
//                      the team to the back.
//   reverse_standings  the same with worst record first (ties: waiver_priority);
//                      winning doesn't move you.
//   faab               the highest bid (transactions.faab_bid) across all players,
//                      as Yahoo does. Equal bids go by waiver_priority, then the
//                      team's own claim_rank. A claim the team can no longer afford
//                      (earlier wins in the run spent its balance) fails. The winning
//                      bid comes off fantasy_teams.faab_balance; losers pay nothing.
//                      Priority is continual rolling but only spent on ties: a team
//                      that wins a player over an equal bid moves to the back.
import type { Pool, PoolClient } from "pg";
import type { SlotCounts } from "../lineup/rules";
import type {
  FaabBudget,
  FantasyTeamSummary,
  MyClaimsResponse,
  PlayerSummary,
  WaiverClaim,
  WaiverOrder,
} from "../types";
import { getLeagueOverview } from "./league";
import { LineupError, loadValues, withTeamLock, type TeamContext } from "./lineup";
import { faabBidProblem } from "../transactions/policy";
import { completeClaim } from "./transactions";
import { toTeamSummary, type TeamRow } from "./teamLogo";
import { ISO, getTeamFaab, getWaiverLeague, type WaiverLeague } from "./waiverStatus";

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
    logoUrl: null, // the run never shows the team
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
    pool.query<TeamRow & { pending: number; faab_balance: number }>(
      `SELECT ft.id::int, ft.name, ft.abbreviation, ft.logo_updated_at,
              coalesce(ft.faab_balance, $2) AS faab_balance,
              (SELECT count(*)::int FROM transactions t
                WHERE t.team_id = ft.id AND t.type = 'waiver_claim' AND t.status = 'pending') AS pending
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
    nextRunAt: league.nextRunAt,
    faabBudget: league.faabBudget,
    faabMinBid: league.faabMinBid,
    teams: order.map((id, i) => {
      const t = byId.get(id)!;
      return {
        ...toTeamSummary(t), priority: i + 1, pendingClaims: t.pending,
        faabBalance: league.type === "faab" ? t.faab_balance : null,
      };
    }),
  };
}

// --- The waiver run ---

/** A claim due in this run. */
export interface DueClaim {
  id: number;
  teamId: number;
  /** The team's claim_rank (lower = preferred). */
  rank: number;
  addPlayerId: number;
  addName: string;
  dropPlayerId: number | null;
  /** FAAB bid in whole dollars; ignored unless the league is FAAB (null = $0). */
  bid: number | null;
}

export interface RunState {
  type: WaiverOrder["type"];
  /** Team ids in waiver order, first first. */
  order: number[];
  /** FAAB: each team's balance before the run. */
  balances: Map<number, number>;
  /** Team abbreviations, for the reasons claims fail. */
  abbr: Map<number, string>;
}

/** What completing a claim also changes: the new waiver order (null = unchanged) and the FAAB charge. */
export interface WinEffects {
  order: number[] | null;
  charge: number;
}

export type ClaimOutcome =
  | { claim: DueClaim; won: true; charge: number; tie: boolean }
  | { claim: DueClaim; won: false; reason: string };

/**
 * Decides a run's claims, one at a time, in the order the league's waiver type
 * says (see the top of this file). `attempt` tries to complete a claim against
 * the rosters as they are now, applying `effects` with it, and returns why it
 * failed or null. Returns every claim's outcome in the order decided, and the
 * waiver order and balances after the run. No I/O of its own.
 */
export async function resolveClaims(
  claims: DueClaim[], state: RunState, attempt: (claim: DueClaim, effects: WinEffects) => Promise<string | null>,
): Promise<{ outcomes: ClaimOutcome[]; order: number[]; balances: Map<number, number> }> {
  const faab = state.type === "faab";
  let order = [...state.order];
  const balances = new Map(state.balances);
  const bid = (c: DueClaim) => (faab ? c.bid ?? 0 : 0);
  const balance = (teamId: number) => balances.get(teamId) ?? 0;
  // Teams missing from the order (shouldn't happen) go last.
  const pos = (teamId: number) => {
    const i = order.indexOf(teamId);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const abbr = (teamId: number) => state.abbr.get(teamId) ?? `team ${teamId}`;
  const outcomes: ClaimOutcome[] = [];
  let open = [...claims];

  while (open.length > 0) {
    // FAAB: the highest bid anywhere. Otherwise the first team in the order
    // with a claim left. Ties: waiver order, then the team's own ranking.
    const claim = open.reduce((best, c) => {
      const d = bid(c) - bid(best) || pos(best.teamId) - pos(c.teamId) || best.rank - c.rank || best.id - c.id;
      return d > 0 ? c : best;
    });
    open = open.filter((c) => c !== claim);

    const amount = bid(claim);
    if (faab && amount > balance(claim.teamId)) {
      const spent = outcomes.some((o) => o.won && o.claim.teamId === claim.teamId && o.charge > 0);
      outcomes.push({
        claim, won: false,
        reason: `You bid $${amount} but had $${balance(claim.teamId)} left${spent ? " after winning earlier claims in this run" : ""}.`,
      });
      continue;
    }
    // A tie: another team bid the same for him and could pay it.
    const tie = faab && open.some((c) => c.addPlayerId === claim.addPlayerId && c.teamId !== claim.teamId
      && bid(c) === amount && bid(c) <= balance(c.teamId));
    const moves = state.type === "continual_rolling" || tie;
    const nextOrder = moves ? [...order.filter((id) => id !== claim.teamId), claim.teamId] : null;

    const reason = await attempt(claim, { order: nextOrder, charge: amount });
    if (reason !== null) {
      outcomes.push({ claim, won: false, reason });
      continue;
    }
    outcomes.push({ claim, won: true, charge: amount, tie });
    if (nextOrder) order = nextOrder;
    if (faab) balances.set(claim.teamId, balance(claim.teamId) - amount);

    const winner = abbr(claim.teamId);
    for (const lost of open.filter((c) => c.addPlayerId === claim.addPlayerId)) {
      const reason = !faab
        ? `${claim.addName} went to ${winner}, ahead of you in the waiver order.`
        : tie && bid(lost) === amount
          ? `${claim.addName} went to ${winner} on a tied $${amount} bid; they were ahead of you in the waiver order.`
          : `${claim.addName} went to ${winner}, who bid $${amount}.`;
      outcomes.push({ claim: lost, won: false, reason });
    }
    open = open.filter((c) => c.addPlayerId !== claim.addPlayerId);
  }
  return { outcomes, order, balances };
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
      faab_bid: number | null;
    }>(
      `SELECT t.id::int, t.team_id::int, t.claim_rank, a.player_id AS add_id,
              trim(p.first_name || ' ' || p.last_name) AS add_name, d.player_id AS drop_id, t.faab_bid
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
      addPlayerId: r.add_id, addName: r.add_name, dropPlayerId: r.drop_id, bid: r.faab_bid,
    }));
    const { rows: teamRows } = await pool.query<{ id: number; abbreviation: string; balance: number }>(
      `SELECT id::int, abbreviation, coalesce(faab_balance, $2) AS balance FROM fantasy_teams WHERE league_id = $1`,
      [leagueId, league.faabBudget],
    );

    const summary: WaiverRunSummary = { leagueId, asOf: asOf.toISOString(), claims: due.length, won: 0, failed: 0, cleared: 0, log: [] };
    const teams = new Map<number, TeamContext>();
    const context = async (teamId: number) => {
      if (!teams.has(teamId)) teams.set(teamId, (await getTeamContext(pool, teamId))!);
      return teams.get(teamId)!;
    };
    const faab = league.type === "faab";
    const state: RunState = {
      type: league.type,
      order: await waiverOrder(pool, league),
      balances: new Map(teamRows.map((t) => [t.id, t.balance])),
      abbr: new Map(teamRows.map((t) => [t.id, t.abbreviation])),
    };

    const { outcomes } = await resolveClaims(due, state, async (claim, effects) =>
      completeClaim(pool, await context(claim.teamId), values, claim, async (db) => {
        if (effects.order) {
          await db.query(
            `UPDATE fantasy_teams ft SET waiver_priority = o.ord
               FROM unnest($1::bigint[]) WITH ORDINALITY AS o(id, ord) WHERE ft.id = o.id`,
            [effects.order],
          );
        }
        if (faab) {
          await db.query(`UPDATE fantasy_teams SET faab_balance = coalesce(faab_balance, $2) - $3 WHERE id = $1`, [
            claim.teamId, league.faabBudget, effects.charge,
          ]);
          await db.query(`UPDATE transactions SET faab_bid = $2 WHERE id = $1`, [claim.id, effects.charge]);
        }
      }),
    );
    for (const o of outcomes) {
      const who = `${state.abbr.get(o.claim.teamId)} ${o.claim.addName}`;
      if (o.won) {
        summary.won++;
        const paid = faab ? ` for $${o.charge}${o.tie ? " (tie, won on priority)" : ""}` : "";
        summary.log.push(`${who}: won${paid}${o.claim.dropPlayerId ? ` (dropped #${o.claim.dropPlayerId})` : ""}`);
      } else {
        await failClaim(pool, o.claim.id, o.reason);
        summary.failed++;
        summary.log.push(`${who}${faab ? ` ($${o.claim.bid ?? 0})` : ""}: failed (${o.reason})`);
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
  faab_bid: number | null;
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
      `SELECT t.id::int, t.status, t.claim_rank, t.faab_bid, ${ISO("t.process_at")} AS process_at,
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
  const faab = await getTeamFaab(pool, team.teamId);
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
        // A pending bid shows only in FAAB leagues; a won claim shows what it cost.
        bid: r.status === "completed" || (r.status === "pending" && faab) ? r.faab_bid : null,
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
    waiverDaysOfWeek: league!.waiverDaysOfWeek,
    nextRunAt: league!.nextRunAt,
    waiverPriority: tc.priority,
    teamCount: tc.n,
    faab,
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

/** Changes one of the team's pending claims' FAAB bid (the league must be FAAB). */
export async function setClaimBid(pool: Pool, team: TeamContext, claimId: number, bid: unknown): Promise<void> {
  await withTeamLock(pool, team.teamId, async (db) => {
    const faab: FaabBudget | null = await getTeamFaab(db, team.teamId);
    if (!faab) throw new LineupError("This league doesn't use FAAB bids.", 409);
    const problem = faabBidProblem(faab, bid);
    if (problem) throw new LineupError(problem, 400);
    const { rowCount } = await db.query(
      `UPDATE transactions SET faab_bid = $3 WHERE id = $1 AND team_id = $2 AND type = 'waiver_claim' AND status = 'pending'`,
      [claimId, team.teamId, bid],
    );
    if (rowCount === 0) throw new LineupError("That claim isn't pending anymore.", 404);
  });
}

// Add / drop behind /api/team/transactions.
//
// A roster move is one DB transaction holding the team lock (withTeamLock):
// freeze lineups through today (so the past keeps its record), check the
// rules against today's lineup, change roster_players, and write a
// transactions row with one transaction_players row per player moved.
//
// Rules:
// - The roster limit is the league's non-IL slots (roster_slots minus IL and
//   IL+); players on IL/IL+ today don't count. An add over the limit needs a drop.
// - An illegal roster (lineup/rules.ts rosterProblems: someone on IL who no
//   longer qualifies, or too many active players) can't add anyone, waiver
//   claims included, unless the same move's drop makes it legal. Drops alone
//   are always allowed: they're one way to fix it.
// - Adds (free agents and waiver claims, not trades) are capped per matchup
//   week and per season by leagues.max_adds_per_week / max_adds_per_season.
// - A player locked in a starting slot today (his game has tipped off, or the
//   day's first game in a first_game league) can't be dropped: today's
//   scoring would lose him.
// - Whether an add is immediate or a waiver claim is decided by
//   transactions/policy.ts. A claim is validated the same way when it's placed
//   (so the manager hears about problems now) and again when the waiver run
//   processes it (queries/waivers.ts calls completeClaim), since rosters change
//   in between. Dropped players go on waivers (waiver_players) per the policy.
import type { Pool, PoolClient } from "pg";
import { activeRosterLimit, isIlSlot, isStarting, rosterProblems } from "../lineup/rules";
import { addMode, dropDestination, type MovePolicyLeague } from "../transactions/policy";
import type {
  AddCandidate,
  PlayerWaiver,
  PlayerOwner,
  PlayerSummary,
  RosterMoveOption,
  RosterMoveResult,
  RosterMovesContext,
} from "../types";
import { LineupError, freezeLineups, loadDay, withTeamLock, type DayState, type TeamContext, type Values } from "./lineup";
import { categoryLine } from "./players";

type Db = Pool | PoolClient;

/** A move the rules refuse; the message is shown to the manager. */
export class TransactionError extends LineupError {}

interface LeagueRules extends MovePolicyLeague {
  maxAddsPerWeek: number | null;
  maxAddsPerSeason: number | null;
  teamCount: number;
  timeZone: string;
}

async function loadRules(db: Db, leagueId: number): Promise<LeagueRules> {
  const { rows: [r] } = await db.query<{
    max_adds_per_week: number | null; max_adds_per_season: number | null; waiver_days: number;
    waivers_after_game_start: boolean; team_count: number; time_zone: string;
  }>(
    `SELECT l.max_adds_per_week, l.max_adds_per_season, l.waiver_days, l.waivers_after_game_start, l.time_zone,
            (SELECT count(*)::int FROM fantasy_teams ft WHERE ft.league_id = l.id) AS team_count
       FROM leagues l WHERE l.id = $1`,
    [leagueId],
  );
  return {
    maxAddsPerWeek: r.max_adds_per_week, maxAddsPerSeason: r.max_adds_per_season, waiverDays: r.waiver_days,
    waiversAfterGameStart: r.waivers_after_game_start, teamCount: r.team_count, timeZone: r.time_zone,
  };
}

/** Completed adds this matchup week (the week containing today) and this season. */
async function countAdds(db: Db, team: TeamContext): Promise<{ week: number; season: number }> {
  const { rows: [r] } = await db.query<{ week: number; season: number }>(
    `SELECT count(*) FILTER (WHERE w.week IS NOT NULL)::int AS week, count(*)::int AS season
       FROM transactions t
       JOIN leagues l ON l.id = t.league_id
       LEFT JOIN league_weeks w ON w.league_id = t.league_id AND $2::date BETWEEN w.starts_on AND w.ends_on
                               AND (t.created_at AT TIME ZONE l.time_zone)::date BETWEEN w.starts_on AND w.ends_on
      WHERE t.team_id = $1 AND t.status = 'completed' AND t.type IN ('add', 'add_drop', 'waiver_claim')`,
    [team.teamId, team.today],
  );
  return r;
}

const rosterLimit = (team: TeamContext) => activeRosterLimit(team.rosterSlots);

const countsAgainstLimit = (day: DayState) => day.players.filter((p) => !isIlSlot(p.slot)).length;

/** Today's roster problems if `dropId` were gone (null = as it is). */
function problemsAfterDrop(team: TeamContext, day: DayState, dropId: number | null): string[] {
  if (dropId === null) return day.problems;
  const rest = day.players.filter((p) => p.id !== dropId).map((p) => ({ ...p, name: name(p) }));
  return rosterProblems(rest, team.rosterSlots);
}

const illegalMessage = (problems: string[]) => `Your roster is illegal, so you can't add players until it's fixed. ${problems[0]}`;

const name = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim();

function dropBlocked(p: DayState["players"][number]): string | null {
  if (p.lock !== null && isStarting(p.slot)) {
    return `${name(p)} is locked in today's lineup (${p.slot}) and can't be dropped until tomorrow.`;
  }
  return null;
}

interface TargetRow {
  id: number;
  first_name: string;
  last_name: string;
  position: string | null;
  nba_person_id: number | null;
  team_abbr: string | null;
  owner_team_id: number | null;
  owner_abbr: string | null;
  on_waivers: boolean;
  game_started: boolean;
  /** When a claim for him would process: when his waivers clear, else the next waiver run. */
  process_at: string;
  dropped_by_id: number | null;
  dropped_by_abbr: string | null;
  dropped_by_name: string | null;
  /** The manager's team already has a pending claim for him. */
  my_claim: boolean;
}

async function loadTarget(db: Db, team: TeamContext, playerId: number): Promise<TargetRow | null> {
  const { rows } = await db.query<TargetRow>(
    `SELECT p.id, p.first_name, p.last_name, nullif(p.position, '') AS position, p.nba_person_id,
            t.abbreviation AS team_abbr, ft.id::int AS owner_team_id, ft.abbreviation AS owner_abbr,
            -- On waivers until the run that clears him deletes the row (not just
            -- until clears_at), so nobody can add him between clears_at and that run.
            w.player_id IS NOT NULL AS on_waivers,
            EXISTS (SELECT 1 FROM games g
                     WHERE g.date = $3 AND NOT g.postponed AND p.team_id IN (g.home_team_id, g.visitor_team_id)
                       AND coalesce(g.status_state <> 'scheduled' OR g.datetime <= now(), false)) AS game_started,
            to_char(coalesce(w.clears_at, next_waiver_run($2, now())) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS process_at,
            dt.id::int AS dropped_by_id, dt.abbreviation AS dropped_by_abbr, dt.name AS dropped_by_name,
            EXISTS (SELECT 1 FROM transactions c JOIN transaction_players cp ON cp.transaction_id = c.id
                     WHERE c.team_id = $4 AND c.type = 'waiver_claim' AND c.status = 'pending'
                       AND cp.player_id = p.id AND cp.to_team_id = $4) AS my_claim
       FROM players p
       LEFT JOIN teams t ON t.id = p.team_id
       LEFT JOIN roster_players rp ON rp.league_id = $2 AND rp.player_id = p.id
       LEFT JOIN fantasy_teams ft ON ft.id = rp.fantasy_team_id
       LEFT JOIN waiver_players w ON w.league_id = $2 AND w.player_id = p.id
       LEFT JOIN fantasy_teams dt ON dt.id = w.dropped_by_team_id
      WHERE p.id = $1`,
    [playerId, team.leagueId, team.today, team.teamId],
  );
  return rows[0] ?? null;
}

const summary = (r: TargetRow): PlayerSummary => ({
  id: r.id, firstName: r.first_name, lastName: r.last_name, teamAbbr: r.team_abbr,
  position: r.position, nbaPersonId: r.nba_person_id,
});

const targetMode = (rules: LeagueRules, t: TargetRow) => addMode(rules, { onWaivers: t.on_waivers, gameStarted: t.game_started });

function targetWaiver(rules: LeagueRules, t: TargetRow): PlayerWaiver | null {
  if (targetMode(rules, t) !== "waiver") return null;
  return {
    clearsAt: t.process_at,
    reason: t.on_waivers ? "dropped" : "game_started",
    droppedBy: t.dropped_by_id === null ? null : { id: t.dropped_by_id, abbreviation: t.dropped_by_abbr!, name: t.dropped_by_name! },
  };
}

/** `forClaim`: the waiver run is completing this team's own claim for him. */
function addBlocked(
  team: TeamContext, rules: LeagueRules, adds: { week: number; season: number }, t: TargetRow, forClaim = false,
): string | null {
  const who = `${t.first_name} ${t.last_name}`.trim();
  if (t.owner_team_id !== null) {
    return t.owner_team_id === team.teamId ? `${who} is already on your team.` : `${who} is on ${t.owner_abbr}.`;
  }
  if (t.my_claim && !forClaim) {
    return `You already have a claim for ${who}. Change or cancel it under My claims on My team.`;
  }
  if (rules.maxAddsPerWeek !== null && adds.week >= rules.maxAddsPerWeek) {
    return `You've used all ${rules.maxAddsPerWeek} adds this week.`;
  }
  if (rules.maxAddsPerSeason !== null && adds.season >= rules.maxAddsPerSeason) {
    return `You've used all ${rules.maxAddsPerSeason} adds this season.`;
  }
  return null;
}

function seasonLine(values: Values, id: number) {
  const v = values.current.get(id);
  if (!v) return null;
  const { min: _min, ...line } = categoryLine(v.totals, "avg");
  return line;
}

function rosterOptions(team: TeamContext, day: DayState, values: Values): RosterMoveOption[] {
  return day.players
    .map((p) => {
      const cur = values.current.get(p.id);
      const avg = cur ? categoryLine(cur.totals, "avg") : null;
      return {
        id: p.id, firstName: p.firstName, lastName: p.lastName, teamAbbr: p.teamAbbr,
        position: p.position, nbaPersonId: p.nbaPersonId, slot: p.slot, injuryStatus: p.injuryStatus,
        pts: avg?.pts ?? null, reb: avg?.reb ?? null,
        value: Math.round((cur?.value ?? values.previous.get(p.id)?.value ?? 0) * 100) / 100,
        dropBlocked: dropBlocked(p),
        fixesIllegalRoster: day.problems.length > 0 && problemsAfterDrop(team, day, p.id).length === 0
          && countsAgainstLimit(day) - (isIlSlot(p.slot) ? 0 : 1) + 1 <= rosterLimit(team),
      };
    })
    .sort((a, b) => a.value - b.value);
}

/** The add/drop sheet's data: the manager's roster today, limits, and optionally the player to add. */
export async function getRosterMovesContext(
  pool: Pool, team: TeamContext, values: Values, addPlayerId: number | null,
): Promise<RosterMovesContext | null> {
  await withTeamLock(pool, team.teamId, (db) => freezeLineups(db, team.teamId));
  const [day, rules, adds, target] = await Promise.all([
    loadDay(pool, team, team.today, values),
    loadRules(pool, team.leagueId),
    countAdds(pool, team),
    addPlayerId === null ? null : loadTarget(pool, team, addPlayerId),
  ]);
  if (addPlayerId !== null && !target) return null;

  let add: AddCandidate | null = null;
  if (target) {
    add = {
      ...summary(target),
      owner: target.owner_team_id === null ? null : ({ teamId: target.owner_team_id, abbreviation: target.owner_abbr! } satisfies PlayerOwner),
      mode: targetMode(rules, target),
      waiver: targetWaiver(rules, target),
      seasonAverages: seasonLine(values, target.id),
      addBlocked: addBlocked(team, rules, adds, target),
    };
  }
  return {
    team: { id: team.teamId, name: team.teamName, abbreviation: team.abbreviation, waiverPriority: team.waiverPriority },
    teamCount: rules.teamCount,
    today: team.today,
    timeZone: rules.timeZone,
    waiverDays: rules.waiverDays,
    dropsToWaivers: dropDestination(rules) === "waivers",
    rosterCount: countsAgainstLimit(day),
    rosterLimit: rosterLimit(team),
    rosterProblems: day.problems,
    addsThisWeek: adds.week,
    maxAddsPerWeek: rules.maxAddsPerWeek,
    addsThisSeason: adds.season,
    maxAddsPerSeason: rules.maxAddsPerSeason,
    roster: rosterOptions(team, day, values),
    add,
  };
}

interface Move {
  addPlayerId: number | null;
  dropPlayerId: number | null;
}

/**
 * Checks a move against today's roster and the league rules, throwing
 * TransactionError when they refuse it. Freezes lineups first. Call holding
 * the team lock. `forClaim`: the waiver run is completing this team's claim.
 */
async function checkMove(db: PoolClient, team: TeamContext, values: Values, move: Move, forClaim: boolean) {
  const { addPlayerId, dropPlayerId } = move;
  await freezeLineups(db, team.teamId);
  const [day, rules, adds] = await Promise.all([
    loadDay(db, team, team.today, values),
    loadRules(db, team.leagueId),
    countAdds(db, team),
  ]);

  let dropped: PlayerSummary | null = null;
  if (dropPlayerId !== null) {
    const p = day.players.find((x) => x.id === dropPlayerId);
    if (!p) {
      throw new TransactionError(forClaim ? "The player you chose to drop is no longer on your team." : "That player isn't on your team.", 409);
    }
    const blocked = dropBlocked(p);
    if (blocked) throw new TransactionError(blocked, 409);
    dropped = {
      id: p.id, firstName: p.firstName, lastName: p.lastName, teamAbbr: p.teamAbbr,
      position: p.position, nbaPersonId: p.nbaPersonId,
    };
  }

  let target: TargetRow | null = null;
  if (addPlayerId !== null) {
    target = await loadTarget(db, team, addPlayerId);
    if (!target) throw new TransactionError("Player not found.", 404);
    const blocked = addBlocked(team, rules, adds, target, forClaim);
    if (blocked) throw new TransactionError(blocked, 409);
    const problems = problemsAfterDrop(team, day, dropPlayerId);
    if (problems.length > 0) throw new TransactionError(illegalMessage(problems), 409);
    const droppingCounted = dropped !== null && !isIlSlot(day.players.find((x) => x.id === dropPlayerId)!.slot);
    const after = countsAgainstLimit(day) + 1 - (droppingCounted ? 1 : 0);
    if (after > rosterLimit(team)) {
      throw new TransactionError(
        dropped
          ? `Your roster is full (${rosterLimit(team)} not counting IL). Drop a player who isn't on IL.`
          : `Your roster is full (${rosterLimit(team)} not counting IL). Choose a player to drop.`,
        409,
      );
    }
  }
  return { rules, dropped, target };
}

/**
 * Changes the rosters for transaction `transactionId`. `writePlayers` also
 * records transaction_players (a claim wrote its rows when it was placed).
 */
async function applyMove(
  db: PoolClient, team: TeamContext, rules: LeagueRules, transactionId: number,
  dropped: PlayerSummary | null, added: PlayerSummary | null, writePlayers: boolean,
): Promise<void> {
  if (dropped) {
    await db.query(`DELETE FROM roster_players WHERE league_id = $1 AND player_id = $2 AND fantasy_team_id = $3`, [
      team.leagueId, dropped.id, team.teamId,
    ]);
    // Today's and later lineup rows for him would put him back in a slot if
    // he's re-added; the past keeps its record.
    await db.query(`DELETE FROM lineup_slots WHERE fantasy_team_id = $1 AND player_id = $2 AND date >= $3`, [
      team.teamId, dropped.id, team.today,
    ]);
    if (writePlayers) {
      await db.query(
        `INSERT INTO transaction_players (transaction_id, player_id, from_team_id, to_team_id) VALUES ($1, $2, $3, NULL)`,
        [transactionId, dropped.id, team.teamId],
      );
    }
    if (dropDestination(rules) === "waivers") {
      // Clears at the first waiver run at least waiver_days from now.
      await db.query(
        `INSERT INTO waiver_players (league_id, player_id, clears_at, dropped_by_team_id)
         VALUES ($1, $2, next_waiver_run($1, now() + make_interval(days => $3)), $4)
         ON CONFLICT (league_id, player_id) DO UPDATE SET clears_at = EXCLUDED.clears_at, dropped_by_team_id = EXCLUDED.dropped_by_team_id`,
        [team.leagueId, dropped.id, rules.waiverDays, team.teamId],
      );
    }
  }
  if (added) {
    // New players start on the bench; the primary key refuses a player
    // another team grabbed first (caught by the callers).
    await db.query(
      `INSERT INTO roster_players (league_id, player_id, fantasy_team_id, slot) VALUES ($1, $2, $3, 'BN')`,
      [team.leagueId, added.id, team.teamId],
    );
    await db.query(`DELETE FROM waiver_players WHERE league_id = $1 AND player_id = $2`, [team.leagueId, added.id]);
    if (writePlayers) {
      await db.query(
        `INSERT INTO transaction_players (transaction_id, player_id, from_team_id, to_team_id) VALUES ($1, $2, NULL, $3)`,
        [transactionId, added.id, team.teamId],
      );
    }
  }
}

/** Records a pending waiver claim (and its optional drop), last in the team's claim order. */
async function placeClaim(
  db: PoolClient, team: TeamContext, userId: number, target: TargetRow, dropped: PlayerSummary | null,
): Promise<RosterMoveResult> {
  const { rows: [tx] } = await db.query<{ id: string }>(
    `INSERT INTO transactions (league_id, type, status, team_id, created_by, process_at, claim_rank)
     VALUES ($1, 'waiver_claim', 'pending', $2, $3, $4,
             (SELECT coalesce(max(claim_rank), 0) + 1 FROM transactions
               WHERE team_id = $2 AND type = 'waiver_claim' AND status = 'pending'))
     RETURNING id`,
    [team.leagueId, team.teamId, userId, target.process_at],
  );
  const transactionId = Number(tx.id);
  await db.query(
    `INSERT INTO transaction_players (transaction_id, player_id, from_team_id, to_team_id) VALUES ($1, $2, NULL, $3)`,
    [transactionId, target.id, team.teamId],
  );
  if (dropped) {
    await db.query(
      `INSERT INTO transaction_players (transaction_id, player_id, from_team_id, to_team_id) VALUES ($1, $2, $3, NULL)`,
      [transactionId, dropped.id, team.teamId],
    );
  }
  return { transactionId, type: "waiver_claim", status: "pending", processAt: target.process_at, added: summary(target), dropped };
}

/**
 * Adds `addPlayerId` and/or drops `dropPlayerId` for the manager's team, in
 * one transaction, or places a waiver claim when the policy says the add must
 * wait. Throws TransactionError when the rules refuse it.
 */
export async function runRosterMove(
  pool: Pool, team: TeamContext, userId: number, values: Values, move: Move,
): Promise<RosterMoveResult> {
  const { addPlayerId, dropPlayerId } = move;
  if (addPlayerId === null && dropPlayerId === null) throw new TransactionError("Pick a player to add or drop.", 400);
  if (addPlayerId !== null && addPlayerId === dropPlayerId) throw new TransactionError("Can't add and drop the same player.", 400);

  try {
    return await withTeamLock(pool, team.teamId, async (db) => {
      const { rules, dropped, target } = await checkMove(db, team, values, move, false);
      if (target && targetMode(rules, target) === "waiver") return placeClaim(db, team, userId, target, dropped);

      const added = target ? summary(target) : null;
      const type: RosterMoveResult["type"] = added && dropped ? "add_drop" : added ? "add" : "drop";
      const { rows: [tx] } = await db.query<{ id: string }>(
        `INSERT INTO transactions (league_id, type, status, team_id, created_by, processed_at)
         VALUES ($1, $2, 'completed', $3, $4, now()) RETURNING id`,
        [team.leagueId, type, team.teamId, userId],
      );
      const transactionId = Number(tx.id);
      await applyMove(db, team, rules, transactionId, dropped, added, true);
      return { transactionId, type, status: "completed", processAt: null, added, dropped };
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new TransactionError("Another team just added that player.", 409);
    }
    throw err;
  }
}

/**
 * The waiver run's half of a claim: re-checks it against the team's roster
 * now (as runRosterMove would) and, if it still holds, completes it and moves
 * the players. `onComplete` runs in the same DB transaction (the run uses it
 * to move the team down the waiver order). Returns null on success, else why
 * the claim failed (the caller records it).
 */
export async function completeClaim(
  pool: Pool, team: TeamContext, values: Values,
  claim: { id: number; addPlayerId: number; dropPlayerId: number | null },
  onComplete: (db: PoolClient) => Promise<void>,
): Promise<string | null> {
  try {
    return await withTeamLock(pool, team.teamId, async (db) => {
      const { rules, dropped, target } = await checkMove(db, team, values, claim, true);
      const { rowCount } = await db.query(
        `UPDATE transactions SET status = 'completed', processed_at = now() WHERE id = $1 AND status = 'pending'`,
        [claim.id],
      );
      if (rowCount === 0) return "The claim was cancelled.";
      await applyMove(db, team, rules, claim.id, dropped, summary(target!), false);
      await onComplete(db);
      return null;
    });
  } catch (err) {
    if (err instanceof TransactionError) return err.message;
    if ((err as { code?: string }).code === "23505") return "Another team got him first.";
    throw err;
  }
}

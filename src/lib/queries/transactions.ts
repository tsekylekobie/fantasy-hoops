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
// - Adds (free agents and waiver claims, not trades) are capped per matchup
//   week and per season by leagues.max_adds_per_week / max_adds_per_season.
// - A player locked in a starting slot today (his game has tipped off, or the
//   day's first game in a first_game league) can't be dropped: today's
//   scoring would lose him.
// - Whether an add is immediate or a waiver claim is decided by
//   transactions/policy.ts; for now every add is immediate.
import type { Pool, PoolClient } from "pg";
import { isStarting } from "../lineup/rules";
import { addMode, dropDestination, type MovePolicyLeague } from "../transactions/policy";
import type {
  AddCandidate,
  LineupSlot,
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

const IL_SLOTS: LineupSlot[] = ["IL", "IL+"];

interface LeagueRules extends MovePolicyLeague {
  maxAddsPerWeek: number | null;
  maxAddsPerSeason: number | null;
  teamCount: number;
}

async function loadRules(db: Db, leagueId: number): Promise<LeagueRules> {
  const { rows: [r] } = await db.query<{
    max_adds_per_week: number | null; max_adds_per_season: number | null; waiver_days: number;
    waivers_after_game_start: boolean; team_count: number;
  }>(
    `SELECT l.max_adds_per_week, l.max_adds_per_season, l.waiver_days, l.waivers_after_game_start,
            (SELECT count(*)::int FROM fantasy_teams ft WHERE ft.league_id = l.id) AS team_count
       FROM leagues l WHERE l.id = $1`,
    [leagueId],
  );
  return {
    maxAddsPerWeek: r.max_adds_per_week, maxAddsPerSeason: r.max_adds_per_season, waiverDays: r.waiver_days,
    waiversAfterGameStart: r.waivers_after_game_start, teamCount: r.team_count,
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

function rosterLimit(team: TeamContext): number {
  return Object.entries(team.rosterSlots)
    .filter(([slot]) => !IL_SLOTS.includes(slot as LineupSlot))
    .reduce((n, [, count]) => n + (count ?? 0), 0);
}

const countsAgainstLimit = (day: DayState) => day.players.filter((p) => !IL_SLOTS.includes(p.slot)).length;

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
}

async function loadTarget(db: Db, team: TeamContext, playerId: number): Promise<TargetRow | null> {
  const { rows } = await db.query<TargetRow>(
    `SELECT p.id, p.first_name, p.last_name, nullif(p.position, '') AS position, p.nba_person_id,
            t.abbreviation AS team_abbr, ft.id::int AS owner_team_id, ft.abbreviation AS owner_abbr,
            EXISTS (SELECT 1 FROM waiver_players w WHERE w.league_id = $2 AND w.player_id = p.id AND w.clears_at > now()) AS on_waivers,
            EXISTS (SELECT 1 FROM games g
                     WHERE g.date = $3 AND NOT g.postponed AND p.team_id IN (g.home_team_id, g.visitor_team_id)
                       AND coalesce(g.status_state <> 'scheduled' OR g.datetime <= now(), false)) AS game_started
       FROM players p
       LEFT JOIN teams t ON t.id = p.team_id
       LEFT JOIN roster_players rp ON rp.league_id = $2 AND rp.player_id = p.id
       LEFT JOIN fantasy_teams ft ON ft.id = rp.fantasy_team_id
      WHERE p.id = $1`,
    [playerId, team.leagueId, team.today],
  );
  return rows[0] ?? null;
}

const summary = (r: TargetRow): PlayerSummary => ({
  id: r.id, firstName: r.first_name, lastName: r.last_name, teamAbbr: r.team_abbr,
  position: r.position, nbaPersonId: r.nba_person_id,
});

function addBlocked(team: TeamContext, rules: LeagueRules, adds: { week: number; season: number }, t: TargetRow): string | null {
  const who = `${t.first_name} ${t.last_name}`.trim();
  if (t.owner_team_id !== null) {
    return t.owner_team_id === team.teamId ? `${who} is already on your team.` : `${who} is on ${t.owner_abbr}.`;
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

function rosterOptions(day: DayState, values: Values): RosterMoveOption[] {
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
      mode: addMode(rules, { onWaivers: target.on_waivers, gameStarted: target.game_started }),
      seasonAverages: seasonLine(values, target.id),
      addBlocked: addBlocked(team, rules, adds, target),
    };
  }
  return {
    team: { id: team.teamId, name: team.teamName, abbreviation: team.abbreviation, waiverPriority: team.waiverPriority },
    teamCount: rules.teamCount,
    today: team.today,
    rosterCount: countsAgainstLimit(day),
    rosterLimit: rosterLimit(team),
    addsThisWeek: adds.week,
    maxAddsPerWeek: rules.maxAddsPerWeek,
    addsThisSeason: adds.season,
    maxAddsPerSeason: rules.maxAddsPerSeason,
    roster: rosterOptions(day, values),
    add,
  };
}

/**
 * Adds `addPlayerId` and/or drops `dropPlayerId` for the manager's team, in
 * one transaction. Throws TransactionError when the rules refuse it.
 */
export async function runRosterMove(
  pool: Pool, team: TeamContext, userId: number, values: Values,
  move: { addPlayerId: number | null; dropPlayerId: number | null },
): Promise<RosterMoveResult> {
  const { addPlayerId, dropPlayerId } = move;
  if (addPlayerId === null && dropPlayerId === null) throw new TransactionError("Pick a player to add or drop.", 400);
  if (addPlayerId !== null && addPlayerId === dropPlayerId) throw new TransactionError("Can't add and drop the same player.", 400);

  try {
    return await withTeamLock(pool, team.teamId, async (db) => {
      await freezeLineups(db, team.teamId);
      const [day, rules, adds] = await Promise.all([
        loadDay(db, team, team.today, values),
        loadRules(db, team.leagueId),
        countAdds(db, team),
      ]);

      let dropped: PlayerSummary | null = null;
      if (dropPlayerId !== null) {
        const p = day.players.find((x) => x.id === dropPlayerId);
        if (!p) throw new TransactionError("That player isn't on your team.", 409);
        const blocked = dropBlocked(p);
        if (blocked) throw new TransactionError(blocked, 409);
        dropped = {
          id: p.id, firstName: p.firstName, lastName: p.lastName, teamAbbr: p.teamAbbr,
          position: p.position, nbaPersonId: p.nbaPersonId,
        };
      }

      let added: PlayerSummary | null = null;
      if (addPlayerId !== null) {
        const t = await loadTarget(db, team, addPlayerId);
        if (!t) throw new TransactionError("Player not found.", 404);
        const blocked = addBlocked(team, rules, adds, t);
        if (blocked) throw new TransactionError(blocked, 409);
        // Waivers session: record a pending 'waiver_claim' (process_at from the
        // league's waiver_time) and return it, instead of refusing.
        if (addMode(rules, { onWaivers: t.on_waivers, gameStarted: t.game_started }) === "waiver") throw new TransactionError("Waiver claims aren't open yet.", 409);
        const droppingCounted = dropped !== null && !IL_SLOTS.includes(day.players.find((x) => x.id === dropPlayerId)!.slot);
        const after = countsAgainstLimit(day) + 1 - (droppingCounted ? 1 : 0);
        if (after > rosterLimit(team)) {
          throw new TransactionError(
            dropped
              ? `Your roster is full (${rosterLimit(team)} not counting IL). Drop a player who isn't on IL.`
              : `Your roster is full (${rosterLimit(team)} not counting IL). Choose a player to drop.`,
            409,
          );
        }
        added = summary(t);
      }

      const type: RosterMoveResult["type"] = added && dropped ? "add_drop" : added ? "add" : "drop";
      const { rows: [tx] } = await db.query<{ id: string }>(
        `INSERT INTO transactions (league_id, type, status, team_id, created_by, processed_at)
         VALUES ($1, $2, 'completed', $3, $4, now()) RETURNING id`,
        [team.leagueId, type, team.teamId, userId],
      );
      const transactionId = Number(tx.id);

      if (dropped) {
        await db.query(`DELETE FROM roster_players WHERE league_id = $1 AND player_id = $2 AND fantasy_team_id = $3`, [
          team.leagueId, dropped.id, team.teamId,
        ]);
        // Today's and later lineup rows for him would put him back in a slot if
        // he's re-added; the past keeps its record.
        await db.query(`DELETE FROM lineup_slots WHERE fantasy_team_id = $1 AND player_id = $2 AND date >= $3`, [
          team.teamId, dropped.id, team.today,
        ]);
        await db.query(
          `INSERT INTO transaction_players (transaction_id, player_id, from_team_id, to_team_id) VALUES ($1, $2, $3, NULL)`,
          [transactionId, dropped.id, team.teamId],
        );
        if (dropDestination(rules) === "waivers") {
          // Waivers session: insert waiver_players (clears_at from rules.waiverDays) here.
          throw new Error("dropDestination 'waivers' is not implemented");
        }
      }
      if (added) {
        // New players start on the bench; the primary key refuses a player
        // another team grabbed first (caught below).
        await db.query(
          `INSERT INTO roster_players (league_id, player_id, fantasy_team_id, slot) VALUES ($1, $2, $3, 'BN')`,
          [team.leagueId, added.id, team.teamId],
        );
        await db.query(
          `INSERT INTO transaction_players (transaction_id, player_id, from_team_id, to_team_id) VALUES ($1, $2, NULL, $3)`,
          [transactionId, added.id, team.teamId],
        );
      }
      return { transactionId, type, status: "completed", processAt: null, added, dropped };
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new TransactionError("Another team just added that player.", 409);
    }
    throw err;
  }
}

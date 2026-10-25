// Daily lineups behind /api/team/lineup.
//
// Storage (db/migrations/0004_league_play.sql): lineup_slots holds the lineup
// a team set for a date. A day without rows uses the most recent earlier day
// that has them, so a change carries forward until the next day the manager
// set explicitly, and later edits never rewrite past days. Before a team's
// first edit, its standing lineup (roster_players.slot) is saved as rows on
// the season's first day, so past days keep showing what they were.
// roster_players.slot mirrors the latest lineup.
//
// Players who join the roster after a day's rows were written show on BN;
// rows for players who have left are ignored, except on past days with their
// own rows, which are the record of who played.
import type { Pool, PoolClient } from "pg";
import { autoLineup, eligibleSlots, validateLineup, type SlotCounts } from "../lineup/rules";
import {
  LINEUP_SLOTS,
  type LineupGame,
  type LineupLock,
  type LineupPlayer,
  type LineupSlot,
  type TeamLineupResponse,
} from "../types";
import { categoryLine, getSeasonValues } from "./players";

type Db = Pool | PoolClient;

/** A request the rules refuse; the message is shown to the manager. */
export class LineupError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface TeamContext {
  teamId: number;
  teamName: string;
  abbreviation: string;
  waiverPriority: number | null;
  leagueId: number;
  leagueName: string;
  season: number;
  rosterSlots: SlotCounts;
  lineupLock: "game_time" | "first_game";
  ilStatuses: string[];
  ilPlusStatuses: string[];
  /** The league's today, yyyy-mm-dd, in its time zone. */
  today: string;
}

/** The signed-in user's team in `season`'s league; null if they don't have one. */
export async function getUserTeam(db: Db, userId: number, season: number): Promise<TeamContext | null> {
  const { rows } = await db.query<{
    team_id: string; team_name: string; abbreviation: string; waiver_priority: number | null;
    league_id: string; league_name: string; season: number; roster_slots: SlotCounts;
    lineup_lock: "game_time" | "first_game"; il_statuses: string[]; il_plus_statuses: string[]; today: string;
  }>(
    `SELECT ft.id AS team_id, ft.name AS team_name, ft.abbreviation, ft.waiver_priority,
            l.id AS league_id, l.name AS league_name, l.season, l.roster_slots, l.lineup_lock,
            l.il_statuses, l.il_plus_statuses,
            to_char((now() AT TIME ZONE l.time_zone)::date, 'YYYY-MM-DD') AS today
       FROM fantasy_teams ft JOIN leagues l ON l.id = ft.league_id
      WHERE ft.owner_user_id = $1 AND l.season = $2
      ORDER BY l.id DESC
      LIMIT 1`,
    [userId, season],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    teamId: Number(r.team_id), teamName: r.team_name, abbreviation: r.abbreviation,
    waiverPriority: r.waiver_priority, leagueId: Number(r.league_id), leagueName: r.league_name,
    season: r.season, rosterSlots: r.roster_slots, lineupLock: r.lineup_lock,
    ilStatuses: r.il_statuses, ilPlusStatuses: r.il_plus_statuses, today: r.today,
  };
}

/** Season averages and 9CAT values. Auto-set falls back to last season for players with no games yet. */
export interface Values {
  current: Awaited<ReturnType<typeof getSeasonValues>>;
  previous: Awaited<ReturnType<typeof getSeasonValues>>;
}

export async function loadValues(db: Pool, season: number): Promise<Values> {
  const [current, previous] = await Promise.all([getSeasonValues(db, season), getSeasonValues(db, season - 1)]);
  return { current, previous };
}

function playerValue(values: Values, id: number): number {
  return values.current.get(id)?.value ?? values.previous.get(id)?.value ?? 0;
}

interface DayPlayerRow {
  id: number;
  first_name: string;
  last_name: string;
  position: string | null;
  nba_person_id: number | null;
  team_abbr: string | null;
  injury_status: string | null;
  game_id: number | null;
  tipoff: string | null;
  status: string | null;
  status_state: string | null;
  started: boolean;
  home: boolean | null;
  opp_abbr: string | null;
  home_score: number | null;
  visitor_score: number | null;
}

// Whether game `g` has started: the provider says so, or the clock has passed
// tip-off (so stale data locks early, never late).
const started = (g: string) => `coalesce(${g}.status_state <> 'scheduled' OR ${g}.datetime <= now(), false)`;

// One row per player: team, current injury status, and his team's game on $2.
const DAY_PLAYERS_SQL = `
  SELECT p.id, p.first_name, p.last_name, nullif(p.position, '') AS position, p.nba_person_id,
         t.abbreviation AS team_abbr, inj.status AS injury_status,
         g.id AS game_id, to_char(g.datetime AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS tipoff,
         g.status, g.status_state,
         ${started("g")} AS started,
         g.home_team_id = p.team_id AS home, opp.abbreviation AS opp_abbr,
         g.home_team_score AS home_score, g.visitor_team_score AS visitor_score
    FROM players p
    LEFT JOIN teams t ON t.id = p.team_id
    LEFT JOIN LATERAL (
      SELECT pi.status FROM player_injuries pi WHERE pi.player_id = p.id ORDER BY pi.observed_at DESC LIMIT 1
    ) inj ON true
    LEFT JOIN LATERAL (
      SELECT * FROM games g
       WHERE g.date = $2 AND NOT g.postponed AND p.team_id IN (g.home_team_id, g.visitor_team_id)
       ORDER BY g.datetime LIMIT 1
    ) g ON true
    LEFT JOIN teams opp ON opp.id = CASE WHEN g.home_team_id = p.team_id THEN g.visitor_team_id ELSE g.home_team_id END
   WHERE p.id = ANY($1)`;

function toGame(r: DayPlayerRow): LineupGame | null {
  if (r.game_id === null) return null;
  const state = r.status_state === "final" ? "final" : r.started ? "live" : "scheduled";
  const [team, opp] = r.home ? [r.home_score, r.visitor_score] : [r.visitor_score, r.home_score];
  return {
    opponentAbbr: r.opp_abbr ?? "",
    home: r.home ?? false,
    tipoff: r.tipoff,
    state,
    // Scheduled games carry their tip-off timestamp in `status`, which is still
    // there when the clock has passed tip-off but the provider hasn't updated.
    statusText: state === "live" && r.status && !/^\d{4}-\d{2}-\d{2}T/.test(r.status) ? r.status : null,
    teamScore: state === "scheduled" ? null : team,
    opponentScore: state === "scheduled" ? null : opp,
  };
}

/** A lineup player before the week's game counts are added (getTeamLineup does that). */
type DayPlayer = Omit<LineupPlayer, "weekGames">;

/** A team's lineup on one date, with what the rules need to know about each player. */
export interface DayState {
  date: string;
  players: DayPlayer[];
  /** Whether this exact date has its own rows (vs. carrying an earlier day forward). */
  hasOwnRows: boolean;
}

export async function loadDay(db: Db, team: TeamContext, date: string, values: Values): Promise<DayState> {
  const [srcRes, rosterRes] = await Promise.all([
    db.query<{ player_id: number; slot: LineupSlot; src: string }>(
      `SELECT ls.player_id, ls.slot, to_char(ls.date, 'YYYY-MM-DD') AS src
         FROM lineup_slots ls
        WHERE ls.fantasy_team_id = $1
          AND ls.date = (SELECT max(date) FROM lineup_slots WHERE fantasy_team_id = $1 AND date <= $2)`,
      [team.teamId, date],
    ),
    db.query<{ player_id: number; slot: LineupSlot }>(
      `SELECT player_id, slot FROM roster_players WHERE fantasy_team_id = $1`,
      [team.teamId],
    ),
  ]);
  const src = srcRes.rows;
  const hasOwnRows = src.length > 0 && src[0].src === date;
  const isPast = date < team.today;

  const slots = new Map<number, LineupSlot>();
  if (src.length === 0) {
    for (const r of rosterRes.rows) slots.set(r.player_id, r.slot);
  } else {
    const fromRows = new Map(src.map((r) => [r.player_id, r.slot]));
    for (const r of rosterRes.rows) slots.set(r.player_id, fromRows.get(r.player_id) ?? "BN");
    if (isPast && hasOwnRows) for (const r of src) if (!slots.has(r.player_id)) slots.set(r.player_id, r.slot);
  }

  const [infoRes, dayRes] = await Promise.all([
    db.query<DayPlayerRow>(DAY_PLAYERS_SQL, [[...slots.keys()], date]),
    db.query<{ started: boolean }>(
      `SELECT coalesce(bool_or(${started("g")}), false) AS started FROM games g WHERE g.date = $1 AND NOT g.postponed`,
      [date],
    ),
  ]);
  const dayStarted = dayRes.rows[0]?.started ?? false;
  const il = { il: team.ilStatuses, ilPlus: team.ilPlusStatuses };

  const players: DayPlayer[] = infoRes.rows.map((r) => {
    let lock: LineupLock | null = null;
    if (isPast) lock = "past";
    else if (team.lineupLock === "first_game" && dayStarted) lock = "day";
    else if (r.started) lock = "game";
    const totals = values.current.get(r.id)?.totals;
    return {
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      teamAbbr: r.team_abbr,
      position: r.position,
      nbaPersonId: r.nba_person_id,
      slot: slots.get(r.id)!,
      eligible: eligibleSlots(r.position, r.injury_status, il),
      lock,
      injuryStatus: r.injury_status,
      game: toGame(r),
      season: totals ? { gp: totals.gp, ...categoryLine(totals, "avg") } : null,
    };
  });
  // Display order: by slot, then best value first.
  const order = (s: LineupSlot) => LINEUP_SLOTS.indexOf(s);
  players.sort((a, b) => order(a.slot) - order(b.slot) || playerValue(values, b.id) - playerValue(values, a.id));
  return { date, players, hasOwnRows };
}

/** Writes `date`'s lineup. Call inside a transaction holding the team lock. */
async function writeDay(db: PoolClient, team: TeamContext, date: string, slots: Map<number, LineupSlot>): Promise<void> {
  // First edit ever: keep the standing lineup as the record for earlier days.
  const { rows: [state] } = await db.query<{ any_rows: boolean; later_rows: boolean; first_day: string | null }>(
    `SELECT EXISTS (SELECT 1 FROM lineup_slots WHERE fantasy_team_id = $1) AS any_rows,
            EXISTS (SELECT 1 FROM lineup_slots WHERE fantasy_team_id = $1 AND date > $2) AS later_rows,
            (SELECT to_char(min(date), 'YYYY-MM-DD') FROM games WHERE season = $3) AS first_day`,
    [team.teamId, date, team.season],
  );
  if (!state.any_rows && state.first_day && state.first_day < date) {
    await db.query(
      `INSERT INTO lineup_slots (league_id, fantasy_team_id, date, player_id, slot)
       SELECT league_id, fantasy_team_id, $2, player_id, slot FROM roster_players WHERE fantasy_team_id = $1`,
      [team.teamId, state.first_day],
    );
  }
  await db.query(`DELETE FROM lineup_slots WHERE fantasy_team_id = $1 AND date = $2`, [team.teamId, date]);
  const ids = [...slots.keys()];
  await db.query(
    `INSERT INTO lineup_slots (league_id, fantasy_team_id, date, player_id, slot)
     SELECT $1, $2, $3, u.player_id, u.slot FROM unnest($4::int[], $5::text[]) AS u(player_id, slot)`,
    [team.leagueId, team.teamId, date, ids, ids.map((id) => slots.get(id)!)],
  );
  if (!state.later_rows) {
    await db.query(
      `UPDATE roster_players rp SET slot = u.slot
         FROM unnest($2::int[], $3::text[]) AS u(player_id, slot)
        WHERE rp.fantasy_team_id = $1 AND rp.player_id = u.player_id`,
      [team.teamId, ids, ids.map((id) => slots.get(id)!)],
    );
  }
}

/** Runs `fn` in a transaction that holds the team's row lock, so two tabs can't interleave edits. */
async function withTeamLock<T>(pool: Pool, team: TeamContext, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT 1 FROM fantasy_teams WHERE id = $1 FOR UPDATE`, [team.teamId]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function assertEditable(team: TeamContext, date: string): void {
  if (date < team.today) throw new LineupError("Past days are locked.", 409);
}

function rulePlayers(day: DayState) {
  return day.players.map((p) => ({ id: p.id, slot: p.slot, eligible: p.eligible, locked: p.lock !== null }));
}

/** Saves a manager's lineup for one day after checking it against the rules. */
export async function setLineup(
  pool: Pool, team: TeamContext, date: string, next: Map<number, LineupSlot>, values: Values,
): Promise<void> {
  assertEditable(team, date);
  await withTeamLock(pool, team, async (db) => {
    const day = await loadDay(db, team, date, values);
    const names = new Map(day.players.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]));
    const error = validateLineup(rulePlayers(day), next, team.rosterSlots, names);
    if (error) throw new LineupError(error, 409);
    if (day.players.every((p) => next.get(p.id) === p.slot)) return;
    await writeDay(db, team, date, next);
  });
}

/**
 * Sets the best lineup for `date`, or for each day from `date` to the end of
 * `weekEnd`. Days run in order, so each starts from the one before it.
 * Returns the days that changed.
 */
export async function autoSetLineup(
  pool: Pool, team: TeamContext, dates: string[], values: Values,
): Promise<string[]> {
  for (const d of dates) assertEditable(team, d);
  return withTeamLock(pool, team, async (db) => {
    const changed: string[] = [];
    for (const date of dates) {
      const day = await loadDay(db, team, date, values);
      const next = autoLineup(
        day.players.map((p) => ({
          id: p.id, slot: p.slot, eligible: p.eligible, locked: p.lock !== null,
          plays: p.game !== null && p.injuryStatus !== "Out",
          value: playerValue(values, p.id),
        })),
        team.rosterSlots,
      );
      if (day.players.every((p) => next.get(p.id) === p.slot)) continue;
      await writeDay(db, team, date, next);
      changed.push(date);
    }
    return changed;
  });
}

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The matchup week containing `date`, or null outside the schedule. */
export async function getWeek(db: Db, team: TeamContext, date: string): Promise<TeamLineupResponse["week"]> {
  const { rows } = await db.query<{ week: number; starts_on: string; ends_on: string; is_playoffs: boolean }>(
    `SELECT week, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on, is_playoffs
       FROM league_weeks WHERE league_id = $1 AND $2::date BETWEEN starts_on AND ends_on`,
    [team.leagueId, date],
  );
  const r = rows[0];
  return r ? { week: r.week, startsOn: r.starts_on, endsOn: r.ends_on, isPlayoffs: r.is_playoffs } : null;
}

/** Days from `date` (or today, if later) through the end of `date`'s week. */
export async function remainingWeekDays(db: Db, team: TeamContext, date: string): Promise<string[]> {
  const week = await getWeek(db, team, date);
  const end = week?.endsOn ?? date;
  const out: string[] = [];
  for (let d = date < team.today ? team.today : date; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The full response for one date. */
export async function getTeamLineup(pool: Pool, team: TeamContext, date: string, values: Values): Promise<TeamLineupResponse> {
  const [day, week] = await Promise.all([loadDay(pool, team, date, values), getWeek(pool, team, date)]);
  let start = week?.startsOn;
  let end = week?.endsOn;
  if (!start || !end) {
    // Outside the schedule: the Mon–Sun around the date.
    const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
    start = addDays(date, -dow);
    end = addDays(start, 6);
  }
  const { rows: counts } = await pool.query<{ date: string; n: number }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, count(*)::int AS n
       FROM games WHERE date BETWEEN $1 AND $2 AND NOT postponed GROUP BY date`,
    [start, end],
  );
  const byDate = new Map(counts.map((c) => [c.date, c.n]));
  const { rows: weekGames } = await pool.query<{ id: number; total: number; remaining: number }>(
    `SELECT p.id, count(g.id)::int AS total, count(g.id) FILTER (WHERE NOT ${started("g")})::int AS remaining
       FROM players p
       LEFT JOIN games g ON g.date BETWEEN $2 AND $3 AND NOT g.postponed
                        AND p.team_id IN (g.home_team_id, g.visitor_team_id)
      WHERE p.id = ANY($1)
      GROUP BY p.id`,
    [day.players.map((p) => p.id), start, end],
  );
  const gamesById = new Map(weekGames.map((r) => [r.id, { remaining: r.remaining, total: r.total }]));
  const days: TeamLineupResponse["days"] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push({ date: d, nbaGames: byDate.get(d) ?? 0 });

  return {
    team: { id: team.teamId, name: team.teamName, abbreviation: team.abbreviation, waiverPriority: team.waiverPriority },
    league: {
      id: team.leagueId,
      name: team.leagueName,
      season: team.season,
      lineupLock: team.lineupLock,
      slots: LINEUP_SLOTS.filter((s) => (team.rosterSlots[s] ?? 0) > 0).map((s) => ({ slot: s, count: team.rosterSlots[s]! })),
    },
    date,
    today: team.today,
    week,
    days,
    players: day.players.map((p) => ({ ...p, weekGames: gamesById.get(p.id) ?? { remaining: 0, total: 0 } })),
  };
}

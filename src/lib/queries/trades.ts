// Trades behind /api/trades.
//
// Storage (db/migrations/0004_league_play.sql): a trade is a transactions row
// (type 'trade'; team_id = proposer, trade_team_id = partner) with one
// transaction_players row per player moved, and trade_votes for league vetoes.
//
// Lifecycle, all while status = 'pending':
//   offered  accepted_at NULL. The partner accepts or rejects; the proposer can cancel.
//   review   accepted_at set, process_at = accepted_at + the league's
//            trade_review_days. During it the rest of the league can vote to
//            veto (trade_review = 'league_vote', trade_veto_votes kills it) or
//            the commissioner can veto. With trade_review = 'none' there is no
//            window and it processes on accept.
// Then 'completed', or 'rejected' / 'cancelled' / 'vetoed' / 'failed' (players
// no longer where the trade expects, or a roster would be too big).
//
// Processing (processTrade) swaps roster_players for both teams in one DB
// transaction holding both team locks, after freezeLineups pins every day
// through today. A trade whose players are locked today (game tipped off, or
// the day's first tip with first_game locks) waits until they unlock, i.e. the
// next day, so today's lineups and matchup stats never change underneath anyone.
// Due trades are processed by the sync worker (scripts/worker.ts) and lazily on
// read (processDueTrades).
import type { Pool, PoolClient } from "pg";
import type { SlotCounts } from "../lineup/rules";
import {
  type FantasyTeamSummary,
  type PlayerSummary,
  type Trade,
  type TradeAction,
  type TradeBuilderResponse,
  type TradeProposal,
  type TradeReview,
  type TradeRosterPlayer,
  type TradeSettings,
  type TradeStatus,
  type TradesResponse,
  type LineupSlot,
  LINEUP_SLOTS,
} from "../types";
import { freezeLineups } from "./lineup";
import { categoryLine, getSeasonValues } from "./players";

type Db = Pool | PoolClient;

/** A request the rules refuse; the message is shown to the manager. */
export class TradeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Most players on one side of a trade. */
export const MAX_TRADE_PLAYERS = 6;
const MAX_NOTE = 500;
const IL_SLOTS = ["IL", "IL+"];

export interface TradeLeague {
  id: number;
  season: number;
  commissionerUserId: number | null;
  settings: TradeSettings;
  lineupLock: "game_time" | "first_game";
  /** The league's today, yyyy-mm-dd. */
  today: string;
}

/** `season`'s league (the newest, as elsewhere) with its trade settings; null if none. */
export async function getTradeLeague(db: Db, season: number): Promise<TradeLeague | null> {
  const { rows: [r] } = await db.query<{
    id: number; season: number; commissioner_user_id: number | null; trade_review: TradeReview;
    trade_review_days: number; trade_veto_votes: number; trade_deadline: string | null;
    roster_slots: SlotCounts; lineup_lock: "game_time" | "first_game"; today: string;
  }>(
    `SELECT id::int, season, commissioner_user_id::int, trade_review, trade_review_days, trade_veto_votes,
            to_char(trade_deadline, 'YYYY-MM-DD') AS trade_deadline, roster_slots, lineup_lock,
            to_char((now() AT TIME ZONE time_zone)::date, 'YYYY-MM-DD') AS today
       FROM leagues WHERE season = $1 ORDER BY id DESC LIMIT 1`,
    [season],
  );
  if (!r) return null;
  const activeLimit = LINEUP_SLOTS.filter((s) => !IL_SLOTS.includes(s)).reduce((n, s) => n + (r.roster_slots[s] ?? 0), 0);
  return {
    id: r.id,
    season: r.season,
    commissionerUserId: r.commissioner_user_id,
    settings: {
      review: r.trade_review,
      reviewDays: r.trade_review_days,
      vetoVotes: r.trade_veto_votes,
      deadline: r.trade_deadline,
      activeLimit,
    },
    lineupLock: r.lineup_lock,
    today: r.today,
  };
}

async function leagueTeams(db: Db, leagueId: number) {
  const { rows } = await db.query<FantasyTeamSummary & { owner_user_id: number | null }>(
    `SELECT id::int, name, abbreviation, owner_user_id::int FROM fantasy_teams WHERE league_id = $1`,
    [leagueId],
  );
  return rows;
}

const summary = (t: FantasyTeamSummary): FantasyTeamSummary => ({ id: t.id, name: t.name, abbreviation: t.abbreviation });

// ---------------------------------------------------------------------------
// Reading

interface TradeRow {
  id: number;
  status: "pending" | "completed" | "rejected" | "cancelled" | "vetoed" | "failed";
  team_id: number;
  trade_team_id: number;
  note: string | null;
  created_at: string;
  accepted_at: string | null;
  process_at: string | null;
  processed_at: string | null;
  failure_reason: string | null;
  votes: number;
  my_vote: boolean;
}

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

const TRADE_COLS = `
  t.id::int, t.status, t.team_id::int, t.trade_team_id::int, t.note,
  ${ISO("t.created_at")} AS created_at, ${ISO("t.accepted_at")} AS accepted_at,
  ${ISO("t.process_at")} AS process_at, ${ISO("t.processed_at")} AS processed_at, t.failure_reason,
  (SELECT count(*)::int FROM trade_votes v WHERE v.transaction_id = t.id) AS votes,
  EXISTS (SELECT 1 FROM trade_votes v WHERE v.transaction_id = t.id AND v.team_id = $2) AS my_vote`;

interface Viewer {
  userId: number | null;
  team: FantasyTeamSummary | null;
}

async function buildTrades(db: Db, league: TradeLeague, viewer: Viewer, rows: TradeRow[]): Promise<Trade[]> {
  if (rows.length === 0) return [];
  const teams = new Map((await leagueTeams(db, league.id)).map((t) => [t.id, summary(t)]));
  const { rows: players } = await db.query<{
    transaction_id: number; from_team_id: number; id: number; first_name: string; last_name: string;
    position: string | null; nba_person_id: number | null; team_abbr: string | null;
  }>(
    `SELECT tp.transaction_id::int, tp.from_team_id::int, p.id, p.first_name, p.last_name,
            nullif(p.position, '') AS position, p.nba_person_id, tm.abbreviation AS team_abbr
       FROM transaction_players tp
       JOIN players p ON p.id = tp.player_id
       LEFT JOIN teams tm ON tm.id = p.team_id
      WHERE tp.transaction_id = ANY($1)
      ORDER BY p.last_name, p.first_name`,
    [rows.map((r) => r.id)],
  );
  const isCommish = viewer.userId !== null && viewer.userId === league.commissionerUserId;
  return rows.map((r) => {
    const status: TradeStatus = r.status === "pending" ? (r.accepted_at ? "review" : "offered") : r.status;
    const mine = viewer.team?.id;
    const role: Trade["role"] = !mine ? null : mine === r.team_id ? "proposer" : mine === r.trade_team_id ? "partner" : "league";
    const moved = players.filter((p) => p.transaction_id === r.id);
    const toSummary = (p: (typeof moved)[number]): PlayerSummary => ({
      id: p.id, firstName: p.first_name, lastName: p.last_name, teamAbbr: p.team_abbr,
      position: p.position, nbaPersonId: p.nba_person_id,
    });
    const involved = role === "proposer" || role === "partner";
    return {
      id: r.id,
      status,
      proposer: teams.get(r.team_id)!,
      partner: teams.get(r.trade_team_id)!,
      sends: moved.filter((p) => p.from_team_id === r.team_id).map(toSummary),
      receives: moved.filter((p) => p.from_team_id === r.trade_team_id).map(toSummary),
      note: r.note,
      createdAt: r.created_at,
      acceptedAt: r.accepted_at,
      processAt: r.process_at,
      closedAt: r.processed_at,
      reason: r.failure_reason,
      vetoVotes: r.votes,
      role,
      myVote: r.my_vote,
      can: {
        accept: status === "offered" && role === "partner",
        reject: status === "offered" && role === "partner",
        cancel: status === "offered" && role === "proposer",
        vote: status === "review" && role === "league" && league.settings.review === "league_vote",
        veto: status === "review" && isCommish && !involved && league.settings.review !== "none",
      },
    };
  });
}

async function viewerFor(db: Db, league: TradeLeague, userId: number | null): Promise<Viewer> {
  if (userId === null) return { userId, team: null };
  const { rows: [t] } = await db.query<FantasyTeamSummary>(
    `SELECT id::int, name, abbreviation FROM fantasy_teams WHERE league_id = $1 AND owner_user_id = $2`,
    [league.id, userId],
  );
  return { userId, team: t ?? null };
}

/**
 * Open trades the viewer may see (offers only to the two teams; trades in
 * review to everyone) and the latest closed ones (rejections, cancellations
 * and failures only to the two teams). Processes due trades first.
 */
export async function listTrades(pool: Pool, league: TradeLeague, userId: number | null): Promise<TradesResponse> {
  await processDueTrades(pool, league.id);
  const viewer = await viewerFor(pool, league, userId);
  const myTeamId = viewer.team?.id ?? 0;
  const visible = `($2 IN (t.team_id, t.trade_team_id) OR %s)`;
  const [{ rows: open }, { rows: recent }] = await Promise.all([
    pool.query<TradeRow>(
      `SELECT ${TRADE_COLS} FROM transactions t
        WHERE t.league_id = $1 AND t.type = 'trade' AND t.status = 'pending'
          AND ${visible.replace("%s", "t.accepted_at IS NOT NULL")}
        ORDER BY coalesce(t.accepted_at, t.created_at) DESC`,
      [league.id, myTeamId],
    ),
    pool.query<TradeRow>(
      `SELECT ${TRADE_COLS} FROM transactions t
        WHERE t.league_id = $1 AND t.type = 'trade' AND t.status <> 'pending'
          AND ${visible.replace("%s", "t.status IN ('completed', 'vetoed')")}
        ORDER BY t.processed_at DESC NULLS LAST, t.id DESC
        LIMIT 10`,
      [league.id, myTeamId],
    ),
  ]);
  return {
    settings: league.settings,
    myTeam: viewer.team,
    isCommissioner: userId !== null && userId === league.commissionerUserId,
    open: await buildTrades(pool, league, viewer, open),
    recent: await buildTrades(pool, league, viewer, recent),
  };
}

async function getTrade(db: Db, league: TradeLeague, viewer: Viewer, id: number): Promise<Trade | null> {
  const { rows } = await db.query<TradeRow>(
    `SELECT ${TRADE_COLS} FROM transactions t WHERE t.league_id = $1 AND t.type = 'trade' AND t.id = $3`,
    [league.id, viewer.team?.id ?? 0, id],
  );
  return (await buildTrades(db, league, viewer, rows))[0] ?? null;
}

/** Both rosters for a trade between the viewer's team and `partnerId`. */
export async function getTradeBuilder(
  pool: Pool, league: TradeLeague, userId: number, partnerId: number,
): Promise<TradeBuilderResponse> {
  await processDueTrades(pool, league.id);
  const viewer = await viewerFor(pool, league, userId);
  if (!viewer.team) throw new TradeError("You don't have a team in this league.", 404);
  const partner = (await leagueTeams(pool, league.id)).find((t) => t.id === partnerId);
  if (!partner) throw new TradeError("No such team in this league.", 404);
  if (partner.id === viewer.team.id) throw new TradeError("You can't trade with yourself.", 400);

  const [{ rows }, values] = await Promise.all([
    pool.query<{
      team_id: number; id: number; first_name: string; last_name: string; position: string | null;
      nba_person_id: number | null; team_abbr: string | null; slot: LineupSlot; injury_status: string | null;
      in_open_trade: boolean;
    }>(
      `SELECT rp.fantasy_team_id::int AS team_id, p.id, p.first_name, p.last_name,
              nullif(p.position, '') AS position, p.nba_person_id, tm.abbreviation AS team_abbr, rp.slot,
              (SELECT pi.status FROM player_injuries pi WHERE pi.player_id = p.id ORDER BY pi.observed_at DESC LIMIT 1)
                AS injury_status,
              EXISTS (SELECT 1 FROM transaction_players tp JOIN transactions t ON t.id = tp.transaction_id
                       WHERE tp.player_id = p.id AND t.league_id = rp.league_id
                         AND t.type = 'trade' AND t.status = 'pending') AS in_open_trade
         FROM roster_players rp
         JOIN players p ON p.id = rp.player_id
         LEFT JOIN teams tm ON tm.id = p.team_id
        WHERE rp.league_id = $1 AND rp.fantasy_team_id = ANY($2)`,
      [league.id, [viewer.team.id, partner.id]],
    ),
    getSeasonValues(pool, league.season),
  ]);
  const toPlayer = (r: (typeof rows)[number]): TradeRosterPlayer => {
    const v = values.get(r.id);
    const line = v ? categoryLine(v.totals, "avg") : null;
    return {
      id: r.id, firstName: r.first_name, lastName: r.last_name, teamAbbr: r.team_abbr, position: r.position,
      nbaPersonId: r.nba_person_id, slot: r.slot, injuryStatus: r.injury_status,
      gp: v?.totals.gp ?? 0,
      stats: line,
      value: v ? Math.round(v.value * 100) / 100 : null,
      inOpenTrade: r.in_open_trade,
    };
  };
  const roster = (teamId: number) =>
    rows
      .filter((r) => r.team_id === teamId)
      .map(toPlayer)
      .sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity) || a.lastName.localeCompare(b.lastName));
  return {
    settings: league.settings,
    myTeam: { ...viewer.team, players: roster(viewer.team.id) },
    partner: { ...summary(partner), players: roster(partner.id) },
    today: league.today,
  };
}

// ---------------------------------------------------------------------------
// Rules shared by proposing, accepting and processing

interface Side {
  teamId: number;
  teamName: string;
  /** Player ids this team gives up. */
  out: number[];
}

/**
 * Null if every player is still on the team giving him up and neither team
 * ends up with more active (non-IL) players than the league allows; else why not.
 * Players arrive on the bench, so they count as active.
 */
async function checkRosters(db: Db, league: TradeLeague, a: Side, b: Side): Promise<string | null> {
  const { rows } = await db.query<{ player_id: number; fantasy_team_id: number; slot: LineupSlot; name: string }>(
    `SELECT p.id AS player_id, rp.fantasy_team_id::int, rp.slot, trim(p.first_name || ' ' || p.last_name) AS name
       FROM players p
       LEFT JOIN roster_players rp ON rp.player_id = p.id AND rp.league_id = $1
      WHERE p.id = ANY($2)`,
    [league.id, [...a.out, ...b.out]],
  );
  const byId = new Map(rows.map((r) => [r.player_id, r]));
  for (const side of [a, b]) {
    for (const id of side.out) {
      const r = byId.get(id);
      if (!r || r.fantasy_team_id !== side.teamId) return `${r?.name ?? `Player ${id}`} isn't on ${side.teamName}.`;
    }
  }
  const { rows: counts } = await db.query<{ team_id: number; active: number }>(
    `SELECT fantasy_team_id::int AS team_id, count(*) FILTER (WHERE slot NOT IN ('IL', 'IL+'))::int AS active
       FROM roster_players WHERE league_id = $1 AND fantasy_team_id = ANY($2) GROUP BY fantasy_team_id`,
    [league.id, [a.teamId, b.teamId]],
  );
  for (const [side, other] of [[a, b], [b, a]] as const) {
    const now = counts.find((c) => c.team_id === side.teamId)?.active ?? 0;
    const leavingActive = side.out.filter((id) => !IL_SLOTS.includes(byId.get(id)!.slot)).length;
    const after = now - leavingActive + other.out.length;
    if (after > league.settings.activeLimit && after > now) {
      return `${side.teamName} would have ${after} active players; the limit is ${league.settings.activeLimit}. ` +
        `They need to drop ${after - league.settings.activeLimit} first, or the trade needs to even out.`;
    }
  }
  return null;
}

function assertBeforeDeadline(league: TradeLeague): void {
  const d = league.settings.deadline;
  if (d && league.today > d) throw new TradeError(`The trade deadline (${d}) has passed.`, 409);
}

// ---------------------------------------------------------------------------
// Writing

async function inTransaction<T>(pool: Pool, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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

/** Locks both teams' rows in id order (the same lock withTeamLock takes), so roster writes can't interleave. */
async function lockTeams(db: PoolClient, ids: number[]): Promise<void> {
  await db.query(`SELECT 1 FROM fantasy_teams WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [ids]);
}

function parseIds(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || !value.every((v) => Number.isInteger(v) && v > 0)) {
    throw new TradeError(`${label} must be a list of player ids.`, 400);
  }
  const ids = [...new Set(value as number[])];
  if (ids.length > MAX_TRADE_PLAYERS) throw new TradeError(`At most ${MAX_TRADE_PLAYERS} players a side.`, 400);
  return ids;
}

/** Proposes a trade from the viewer's team. Returns it. */
export async function proposeTrade(pool: Pool, league: TradeLeague, userId: number, body: Partial<TradeProposal>): Promise<Trade> {
  assertBeforeDeadline(league);
  const viewer = await viewerFor(pool, league, userId);
  if (!viewer.team) throw new TradeError("You don't have a team in this league.", 404);
  const me = viewer.team;
  const partner = (await leagueTeams(pool, league.id)).find((t) => t.id === body.partnerTeamId);
  if (!partner) throw new TradeError("Pick a team in this league to trade with.", 400);
  if (partner.id === me.id) throw new TradeError("You can't trade with yourself.", 400);
  const send = parseIds(body.sendPlayerIds, "sendPlayerIds");
  const receive = parseIds(body.receivePlayerIds, "receivePlayerIds");
  if (send.length === 0 || receive.length === 0) {
    throw new TradeError("Pick at least one player from each team.", 400);
  }
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, MAX_NOTE) : null;

  const id = await inTransaction(pool, async (db) => {
    await lockTeams(db, [me.id, partner.id]);
    const problem = await checkRosters(
      db, league,
      { teamId: me.id, teamName: me.name, out: send },
      { teamId: partner.id, teamName: partner.name, out: receive },
    );
    if (problem) throw new TradeError(problem, 409);
    const { rows: [t] } = await db.query<{ id: number }>(
      `INSERT INTO transactions (league_id, type, status, team_id, trade_team_id, created_by, note)
       VALUES ($1, 'trade', 'pending', $2, $3, $4, $5) RETURNING id::int`,
      [league.id, me.id, partner.id, userId, note],
    );
    await db.query(
      `INSERT INTO transaction_players (transaction_id, player_id, from_team_id, to_team_id)
       SELECT $1, u.player_id, u.from_id, u.to_id
         FROM unnest($2::int[], $3::bigint[], $4::bigint[]) AS u(player_id, from_id, to_id)`,
      [
        t.id,
        [...send, ...receive],
        [...send.map(() => me.id), ...receive.map(() => partner.id)],
        [...send.map(() => partner.id), ...receive.map(() => me.id)],
      ],
    );
    return t.id;
  });
  return (await getTrade(pool, league, viewer, id))!;
}

/** One manager's action on a trade (see TradeAction). Returns the trade as it now stands. */
export async function actOnTrade(
  pool: Pool, league: TradeLeague, userId: number, tradeId: number, action: TradeAction,
): Promise<Trade> {
  // A trade whose window just ended processes before anyone can still vote on it.
  await processDueTrades(pool, league.id);
  const viewer = await viewerFor(pool, league, userId);
  const before = await getTrade(pool, league, viewer, tradeId);
  // Offers are private to the two teams.
  if (!before || (before.status === "offered" && before.role !== "proposer" && before.role !== "partner")) {
    throw new TradeError("No such trade.", 404);
  }
  if (!before.can[action === "unvote" ? "vote" : action]) {
    throw new TradeError(refusal(before, action), 409);
  }

  let processNow = false;
  await inTransaction(pool, async (db) => {
    // Lock the trade and re-check its state: another request may have moved it on.
    const { rows: [t] } = await db.query<{ status: string; accepted_at: Date | null }>(
      `SELECT status, accepted_at FROM transactions WHERE id = $1 FOR UPDATE`,
      [tradeId],
    );
    const current = t.status !== "pending" ? "closed" : t.accepted_at ? "review" : "offered";
    if (current !== before.status) throw new TradeError("This trade has changed; refresh and try again.", 409);

    switch (action) {
      case "accept": {
        assertBeforeDeadline(league);
        const problem = await checkRosters(
          db, league,
          { teamId: before.proposer.id, teamName: before.proposer.name, out: before.sends.map((p) => p.id) },
          { teamId: before.partner.id, teamName: before.partner.name, out: before.receives.map((p) => p.id) },
        );
        if (problem) throw new TradeError(problem, 409);
        const days = league.settings.review === "none" ? 0 : league.settings.reviewDays;
        await db.query(
          `UPDATE transactions SET accepted_at = now(), process_at = now() + make_interval(days => $2) WHERE id = $1`,
          [tradeId, days],
        );
        processNow = days === 0;
        break;
      }
      case "reject":
      case "cancel":
        await db.query(
          `UPDATE transactions SET status = $2, processed_at = now() WHERE id = $1`,
          [tradeId, action === "reject" ? "rejected" : "cancelled"],
        );
        break;
      case "vote":
      case "unvote": {
        if (action === "vote") {
          await db.query(
            `INSERT INTO trade_votes (transaction_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [tradeId, viewer.team!.id],
          );
        } else {
          await db.query(`DELETE FROM trade_votes WHERE transaction_id = $1 AND team_id = $2`, [tradeId, viewer.team!.id]);
        }
        const { rows: [v] } = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM trade_votes WHERE transaction_id = $1`,
          [tradeId],
        );
        if (v.n >= league.settings.vetoVotes) {
          await db.query(
            `UPDATE transactions SET status = 'vetoed', processed_at = now(), failure_reason = $2 WHERE id = $1`,
            [tradeId, `Vetoed by league vote (${v.n} votes).`],
          );
        }
        break;
      }
      case "veto":
        await db.query(
          `UPDATE transactions SET status = 'vetoed', processed_at = now(), failure_reason = 'Vetoed by the commissioner.'
            WHERE id = $1`,
          [tradeId],
        );
        break;
    }
  });
  if (processNow) await processTrade(pool, tradeId);
  return (await getTrade(pool, league, viewer, tradeId))!;
}

function refusal(t: Trade, action: TradeAction): string {
  if (t.status !== "offered" && t.status !== "review") return `This trade is already ${t.status}.`;
  switch (action) {
    case "accept":
    case "reject":
      return t.status === "review" ? "This trade was already accepted." : `Only ${t.partner.name} can answer this offer.`;
    case "cancel":
      return t.status === "review" ? "Accepted trades can't be withdrawn; it's in review." : "Only the team that proposed it can cancel it.";
    case "vote":
    case "unvote":
      return t.status === "offered"
        ? "Voting opens once the trade is accepted."
        : t.role === "proposer" || t.role === "partner"
          ? "Teams in the trade can't vote on it."
          : "This league doesn't review trades by vote.";
    case "veto":
      return "Only the commissioner can veto, during review.";
  }
}

// ---------------------------------------------------------------------------
// Processing

export type ProcessResult = "completed" | "failed" | "waiting" | "skipped";

/**
 * Processes an accepted trade whose review window is over: re-checks rosters,
 * pins lineups through today, and swaps the players onto the bench of their
 * new teams. Waits (leaves it pending) while any player is locked today.
 */
export async function processTrade(pool: Pool, tradeId: number): Promise<ProcessResult> {
  return inTransaction(pool, async (db) => {
    const { rows: [t] } = await db.query<{
      league_id: number; season: number; team_id: number; trade_team_id: number; due: boolean; pending: boolean;
      lineup_lock: "game_time" | "first_game"; today: string;
    }>(
      `SELECT t.league_id::int, l.season, t.team_id::int, t.trade_team_id::int, t.status = 'pending' AS pending,
              t.accepted_at IS NOT NULL AND t.process_at <= now() AS due, l.lineup_lock,
              to_char((now() AT TIME ZONE l.time_zone)::date, 'YYYY-MM-DD') AS today
         FROM transactions t JOIN leagues l ON l.id = t.league_id
        WHERE t.id = $1 AND t.type = 'trade'`,
      [tradeId],
    );
    if (!t) return "skipped";
    await lockTeams(db, [t.team_id, t.trade_team_id]);
    // Re-read under the team locks, holding the trade too.
    const { rows: [cur] } = await db.query<{ ok: boolean }>(
      `SELECT status = 'pending' AND accepted_at IS NOT NULL AND process_at <= now() AS ok
         FROM transactions WHERE id = $1 FOR UPDATE`,
      [tradeId],
    );
    if (!cur.ok) return "skipped";

    const { rows: moved } = await db.query<{ player_id: number; from_team_id: number; to_team_id: number }>(
      `SELECT player_id, from_team_id::int, to_team_id::int FROM transaction_players WHERE transaction_id = $1`,
      [tradeId],
    );
    const ids = moved.map((m) => m.player_id);

    // Today's locks: a player whose game has tipped off (or, with first_game
    // locks, anyone once the day's first game has) stays put until tomorrow.
    const { rows: [lock] } = await db.query<{ locked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM games g JOIN players p ON p.team_id IN (g.home_team_id, g.visitor_team_id)
          WHERE g.date = $2 AND NOT g.postponed AND p.id = ANY($1)
            AND coalesce(g.status_state <> 'scheduled' OR g.datetime <= now(), false)
       ) OR ($3 = 'first_game' AND EXISTS (
         SELECT 1 FROM games g WHERE g.date = $2 AND NOT g.postponed
            AND coalesce(g.status_state <> 'scheduled' OR g.datetime <= now(), false)
       )) AS locked`,
      [ids, t.today, t.lineup_lock],
    );
    if (lock.locked) return "waiting";

    const league = await getTradeLeague(db, t.season);
    const names = new Map((await leagueTeams(db, t.league_id)).map((x) => [x.id, x.name]));
    const side = (teamId: number): Side => ({
      teamId, teamName: names.get(teamId) ?? "the team", out: moved.filter((m) => m.from_team_id === teamId).map((m) => m.player_id),
    });
    const problem = league && (await checkRosters(db, league, side(t.team_id), side(t.trade_team_id)));
    if (problem) {
      await db.query(
        `UPDATE transactions SET status = 'failed', processed_at = now(), failure_reason = $2 WHERE id = $1`,
        [tradeId, problem],
      );
      return "failed";
    }

    // Pin every day through today first, so past days keep the players where
    // they were. None of them is locked today, so today moves with the trade:
    // the old team's rows for them from today on go (else today, once past,
    // would still credit their games to the old team), and they sit on the new
    // team's bench on each of those days it has rows for.
    await freezeLineups(db, t.team_id);
    await freezeLineups(db, t.trade_team_id);
    await db.query(
      `DELETE FROM lineup_slots ls
        USING transaction_players tp
        WHERE tp.transaction_id = $1 AND ls.player_id = tp.player_id
          AND ls.fantasy_team_id = tp.from_team_id AND ls.date >= $2::date`,
      [tradeId, t.today],
    );
    await db.query(
      `INSERT INTO lineup_slots (league_id, fantasy_team_id, date, player_id, slot)
       SELECT DISTINCT ls.league_id, ls.fantasy_team_id, ls.date, tp.player_id, 'BN'
         FROM transaction_players tp
         JOIN lineup_slots ls ON ls.fantasy_team_id = tp.to_team_id AND ls.date >= $2::date
        WHERE tp.transaction_id = $1
       ON CONFLICT DO NOTHING`,
      [tradeId, t.today],
    );
    await db.query(
      `UPDATE roster_players rp SET fantasy_team_id = tp.to_team_id, slot = 'BN', acquired_at = now()
         FROM transaction_players tp
        WHERE tp.transaction_id = $1 AND rp.league_id = $2 AND rp.player_id = tp.player_id`,
      [tradeId, t.league_id],
    );
    await db.query(`UPDATE transactions SET status = 'completed', processed_at = now() WHERE id = $1`, [tradeId]);
    // Other open trades with these players can't happen any more.
    await db.query(
      `UPDATE transactions t SET status = 'failed', processed_at = now(),
              failure_reason = 'A player in it was traded in another deal.'
        WHERE t.league_id = $1 AND t.type = 'trade' AND t.status = 'pending' AND t.id <> $2
          AND EXISTS (SELECT 1 FROM transaction_players tp WHERE tp.transaction_id = t.id AND tp.player_id = ANY($3))`,
      [t.league_id, tradeId, ids],
    );
    return "completed";
  });
}

/** Processes every trade whose review window has ended (one league, or all). Never throws. */
export async function processDueTrades(pool: Pool, leagueId?: number): Promise<Record<ProcessResult, number>> {
  const out: Record<ProcessResult, number> = { completed: 0, failed: 0, waiting: 0, skipped: 0 };
  try {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id::int FROM transactions
        WHERE type = 'trade' AND status = 'pending' AND accepted_at IS NOT NULL AND process_at <= now()
          AND ($1::bigint IS NULL OR league_id = $1)
        ORDER BY process_at, id`,
      [leagueId ?? null],
    );
    for (const r of rows) out[await processTrade(pool, r.id)]++;
  } catch (err) {
    console.error("processDueTrades failed", err);
  }
  return out;
}

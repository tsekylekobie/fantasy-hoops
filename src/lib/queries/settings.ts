// League settings: the rules on the leagues row that the commissioner
// (leagues.commissioner_user_id) changes from /league/settings. Everything
// else reads these columns live, so a change applies from the next action on.
//
// Changing settings mid-week rewrites nothing that already happened: past
// lineup_slots rows and processed transactions are left alone. The only rows a
// save touches besides the league are pending ones scheduled on the old waiver
// schedule (claims' process_at, waiver_players.clears_at), which move to the
// first run on the new schedule at or after their old time, so nobody clears
// earlier than they would have.
//
// FAAB: switching the league to FAAB gives every team the full budget (and
// pending claims a bid of the minimum); switching away leaves balances alone
// and drops pending claims' bids. Changing the budget while on FAAB adds the
// difference to every team's remaining balance (never below $0), so money
// already spent stays spent and everyone keeps the same gap. A new minimum bid
// applies to bids placed or changed from then on.
//
// Game limits are the exception to "from now on": a change applies from the
// next matchup week. Saving copies them onto every week that hasn't started
// (league_weeks.game_limits, what scoring reads), so the current week keeps its own.
import type { Pool } from "pg";
import { parseGameLimits } from "../lineup/gameLimits";
import type { SlotCounts } from "../lineup/rules";
import { toGameLimits } from "./matchups";
import {
  INJURY_STATUSES,
  LINEUP_SLOTS,
  STARTING_SLOTS,
  type LeagueSettings,
  type LeagueSettingsResponse,
  type TradeReview,
  type WaiverOrder,
} from "../types";
import { bracketRounds } from "../playoffs/bracket";
import { LineupError } from "./lineup";
import { ISO } from "./waiverStatus";

const WAIVER_TYPES: WaiverOrder["type"][] = ["continual_rolling", "reverse_standings", "faab"];
const TRADE_REVIEWS: TradeReview[] = ["none", "commissioner", "league_vote"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const LIMITS = {
  waiverDays: [0, 14],
  faabBudget: [1, 1000],
  ilSlots: [0, 5],
  ilMinDays: [0, 60],
  tradeReviewDays: [0, 7],
  maxAdds: [0, 200],
  playoffTeams: [2, 16],
  toiletBowlTeams: [2, 8],
} as const;

interface LeagueRow {
  id: number;
  name: string;
  commissioner_user_id: number | null;
  team_count: number;
  waiver_type: WaiverOrder["type"];
  waiver_time: string;
  time_zone: string;
  waiver_days_of_week: number[];
  waiver_days: number;
  waivers_after_game_start: boolean;
  faab_budget: number;
  faab_min_bid: number;
  roster_slots: SlotCounts;
  il_statuses: string[];
  il_min_days: number;
  il_plus_statuses: string[];
  il_plus_min_days: number;
  trade_review: TradeReview;
  trade_review_days: number;
  trade_veto_votes: number;
  trade_deadline: string | null;
  max_adds_per_week: number | null;
  max_adds_per_season: number | null;
  playoff_teams: number;
  playoff_start_week: number | null;
  toilet_bowl: boolean;
  toilet_bowl_teams: number;
  game_limits: unknown;
  weeks: { week: number; startsOn: string; endsOn: string }[];
  /** The first week that starts after the league's today (game limits changes start there). */
  next_week: number | null;
  playoffs_started: boolean;
  next_run_at: string;
  updated_at: string;
}

async function loadLeague(pool: Pool, season: number): Promise<LeagueRow | null> {
  const { rows: [r] } = await pool.query<LeagueRow>(
    `SELECT l.id::int, l.name, l.commissioner_user_id::int,
            (SELECT count(*)::int FROM fantasy_teams ft WHERE ft.league_id = l.id) AS team_count,
            l.waiver_type, to_char(l.waiver_time, 'HH24:MI') AS waiver_time, l.time_zone, l.waiver_days_of_week,
            l.waiver_days, l.waivers_after_game_start, l.faab_budget, l.faab_min_bid, l.roster_slots, l.il_statuses, l.il_min_days,
            l.il_plus_statuses, l.il_plus_min_days, l.trade_review, l.trade_review_days, l.trade_veto_votes,
            to_char(l.trade_deadline, 'YYYY-MM-DD') AS trade_deadline, l.max_adds_per_week, l.max_adds_per_season,
            l.playoff_teams, l.playoff_start_week, l.toilet_bowl, l.toilet_bowl_teams, l.game_limits,
            (SELECT min(w.week)::int FROM league_weeks w
              WHERE w.league_id = l.id AND w.starts_on > (now() AT TIME ZONE l.time_zone)::date) AS next_week,
            coalesce((SELECT json_agg(json_build_object('week', w.week, 'startsOn', w.starts_on, 'endsOn', w.ends_on) ORDER BY w.week)
                        FROM league_weeks w WHERE w.league_id = l.id), '[]') AS weeks,
            EXISTS (SELECT 1 FROM matchups m WHERE m.league_id = l.id AND m.bracket IS NOT NULL) AS playoffs_started,
            ${ISO("next_waiver_run(l.id, now())")} AS next_run_at, ${ISO("l.updated_at")} AS updated_at
       FROM leagues l WHERE l.season = $1 ORDER BY l.id DESC LIMIT 1`,
    [season],
  );
  return r ?? null;
}

/** The default first playoff week: as late as the schedule allows. */
const lastStart = (r: LeagueRow) => Math.max(2, r.weeks.length - bracketRounds(Math.min(r.playoff_teams, r.team_count)) + 1);

function toResponse(r: LeagueRow): LeagueSettingsResponse {
  return {
    leagueName: r.name,
    teamCount: r.team_count,
    nextRunAt: r.next_run_at,
    updatedAt: r.updated_at,
    weeks: r.weeks,
    playoffsStarted: r.playoffs_started,
    startingSlots: LINEUP_SLOTS.filter((s) => STARTING_SLOTS.includes(s) && (r.roster_slots[s] ?? 0) > 0)
      .map((slot) => ({ slot, count: r.roster_slots[slot]! })),
    gameLimitsFromWeek: r.next_week,
    settings: {
      waiverType: r.waiver_type,
      waiverTime: r.waiver_time,
      timeZone: r.time_zone,
      waiverDaysOfWeek: r.waiver_days_of_week,
      waiverDays: r.waiver_days,
      waiversAfterGameStart: r.waivers_after_game_start,
      faabBudget: r.faab_budget,
      faabMinBid: r.faab_min_bid,
      ilSlots: r.roster_slots.IL ?? 0,
      ilStatuses: r.il_statuses,
      ilMinDays: r.il_min_days,
      ilPlusSlots: r.roster_slots["IL+"] ?? 0,
      ilPlusStatuses: r.il_plus_statuses,
      ilPlusMinDays: r.il_plus_min_days,
      tradeReview: r.trade_review,
      tradeReviewDays: r.trade_review_days,
      tradeVetoVotes: r.trade_veto_votes,
      tradeDeadline: r.trade_deadline,
      maxAddsPerWeek: r.max_adds_per_week,
      maxAddsPerSeason: r.max_adds_per_season,
      playoffTeams: r.playoff_teams,
      playoffStartWeek: r.playoff_start_week ?? lastStart(r),
      toiletBowl: r.toilet_bowl,
      toiletBowlTeams: r.toilet_bowl_teams,
      gameLimits: toGameLimits(r.game_limits),
    },
  };
}

/** The season's league settings, and whether `userId` is its commissioner; null if there's no league. */
export async function getLeagueSettings(
  pool: Pool, season: number, userId: number | null,
): Promise<{ data: LeagueSettingsResponse; isCommissioner: boolean } | null> {
  const r = await loadLeague(pool, season);
  if (!r) return null;
  return { data: toResponse(r), isCommissioner: userId !== null && r.commissioner_user_id === userId };
}

const isInt = (v: unknown, [min, max]: readonly [number, number]): v is number =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz.includes("/") || tz === "UTC";
  } catch {
    return false;
  }
}

function statuses(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.every((s) => (INJURY_STATUSES as readonly string[]).includes(s))) return null;
  return INJURY_STATUSES.filter((s) => v.includes(s));
}

/**
 * Checks a PUT body; returns the settings (normalised: weekdays and statuses
 * sorted, duplicates dropped) or the first problem, worded for the commissioner.
 * `weekCount` is the length of the schedule (league_weeks), which the playoff
 * rounds (one week each) must fit in after at least one regular-season week.
 */
export function parseSettings(
  body: unknown, teamCount: number, weekCount: number,
): { settings: LeagueSettings } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "Send the settings as a JSON object." };
  const b = body as Record<string, unknown>;

  if (!WAIVER_TYPES.includes(b.waiverType as WaiverOrder["type"])) return { error: "Pick a waiver type." };
  if (typeof b.waiverTime !== "string" || !HHMM.test(b.waiverTime)) return { error: "Waiver time must be HH:MM (24-hour)." };
  if (typeof b.timeZone !== "string" || !isTimeZone(b.timeZone)) return { error: "Pick a time zone." };
  const days = b.waiverDaysOfWeek;
  if (!Array.isArray(days) || days.length === 0 || !days.every((d) => isInt(d, [1, 7]))) {
    return { error: "Waivers need to run on at least one day of the week." };
  }
  if (!isInt(b.waiverDays, LIMITS.waiverDays)) return { error: `Days on waivers must be ${LIMITS.waiverDays.join("–")}.` };
  if (typeof b.waiversAfterGameStart !== "boolean") return { error: "waiversAfterGameStart must be true or false." };
  if (!isInt(b.faabBudget, LIMITS.faabBudget)) return { error: `The FAAB budget must be $${LIMITS.faabBudget.join("–$")}.` };
  if (!isInt(b.faabMinBid, [0, b.faabBudget])) return { error: `The minimum bid must be $0–$${b.faabBudget}.` };

  const il = statuses(b.ilStatuses);
  const ilPlus = statuses(b.ilPlusStatuses);
  if (!il || !ilPlus) return { error: `IL statuses must be from: ${INJURY_STATUSES.join(", ")}.` };
  for (const [label, slots, list, min] of [
    ["IL", b.ilSlots, il, b.ilMinDays],
    ["IL+", b.ilPlusSlots, ilPlus, b.ilPlusMinDays],
  ] as const) {
    if (!isInt(slots, LIMITS.ilSlots)) return { error: `${label} slots must be ${LIMITS.ilSlots.join("–")}.` };
    if (slots > 0 && list.length === 0) return { error: `Pick at least one injury status that can use ${label}.` };
    if (!isInt(min, LIMITS.ilMinDays)) return { error: `${label} minimum days must be ${LIMITS.ilMinDays.join("–")}.` };
  }

  if (!TRADE_REVIEWS.includes(b.tradeReview as TradeReview)) return { error: "Pick how trades are reviewed." };
  if (!isInt(b.tradeReviewDays, LIMITS.tradeReviewDays)) {
    return { error: `Trade review days must be ${LIMITS.tradeReviewDays.join("–")}.` };
  }
  // Two teams are in the trade, so at most teamCount - 2 can vote.
  const maxVotes = Math.max(1, teamCount - 2);
  if (!isInt(b.tradeVetoVotes, [1, maxVotes])) return { error: `Veto votes must be 1–${maxVotes}.` };
  const deadline = b.tradeDeadline;
  if (deadline !== null && (typeof deadline !== "string" || !DATE.test(deadline) || Number.isNaN(Date.parse(`${deadline}T00:00:00Z`)))) {
    return { error: "Trade deadline must be a date or none." };
  }
  for (const [label, v] of [["week", b.maxAddsPerWeek], ["season", b.maxAddsPerSeason]] as const) {
    if (v !== null && !isInt(v, LIMITS.maxAdds)) return { error: `Adds per ${label} must be ${LIMITS.maxAdds.join("–")} or unlimited.` };
  }

  if (!isInt(b.playoffTeams, [LIMITS.playoffTeams[0], Math.min(LIMITS.playoffTeams[1], teamCount)])) {
    return { error: `Playoff teams must be ${LIMITS.playoffTeams[0]}–${Math.min(LIMITS.playoffTeams[1], teamCount)}.` };
  }
  if (typeof b.toiletBowl !== "boolean") return { error: "toiletBowl must be true or false." };
  if (!isInt(b.toiletBowlTeams, LIMITS.toiletBowlTeams)) {
    return { error: `Toilet bowl teams must be ${LIMITS.toiletBowlTeams.join("–")}.` };
  }
  const playoffRounds = bracketRounds(b.playoffTeams);
  if (b.toiletBowl) {
    if (b.playoffTeams + b.toiletBowlTeams > teamCount) {
      return { error: `Playoff and toilet bowl teams add up to more than the league's ${teamCount}.` };
    }
    if (bracketRounds(b.toiletBowlTeams) > playoffRounds) {
      return { error: "The toilet bowl can't have more rounds than the playoffs." };
    }
  }
  // One week per round, after at least one regular-season week.
  const latest = weekCount - playoffRounds + 1;
  if (latest < 2) return { error: `The schedule's ${weekCount} weeks are too few for ${playoffRounds} playoff rounds.` };
  if (!isInt(b.playoffStartWeek, [2, latest])) {
    return { error: `The playoffs take ${playoffRounds} weeks, so they must start in week 2–${latest}.` };
  }
  const gameLimits = parseGameLimits(b.gameLimits);
  if ("error" in gameLimits) return gameLimits;

  return {
    settings: {
      waiverType: b.waiverType as WaiverOrder["type"],
      waiverTime: b.waiverTime,
      timeZone: b.timeZone,
      waiverDaysOfWeek: [...new Set(days as number[])].sort((x, y) => x - y),
      waiverDays: b.waiverDays,
      waiversAfterGameStart: b.waiversAfterGameStart,
      faabBudget: b.faabBudget,
      faabMinBid: b.faabMinBid,
      ilSlots: b.ilSlots as number,
      ilStatuses: il,
      ilMinDays: b.ilMinDays as number,
      ilPlusSlots: b.ilPlusSlots as number,
      ilPlusStatuses: ilPlus,
      ilPlusMinDays: b.ilPlusMinDays as number,
      tradeReview: b.tradeReview as TradeReview,
      tradeReviewDays: b.tradeReviewDays,
      tradeVetoVotes: b.tradeVetoVotes,
      tradeDeadline: deadline as string | null,
      maxAddsPerWeek: b.maxAddsPerWeek as number | null,
      maxAddsPerSeason: b.maxAddsPerSeason as number | null,
      playoffTeams: b.playoffTeams,
      playoffStartWeek: b.playoffStartWeek,
      toiletBowl: b.toiletBowl,
      toiletBowlTeams: b.toiletBowlTeams,
      gameLimits: gameLimits.limits,
    },
  };
}

/**
 * Saves the season's league settings as `userId`, who must be its commissioner
 * (LineupError 403 otherwise; 400 for bad input, 409 when fewer IL slots than
 * teams are using). Responds with the saved settings and the next waiver run.
 */
export async function updateLeagueSettings(
  pool: Pool, season: number, userId: number, body: unknown,
): Promise<LeagueSettingsResponse> {
  const current = await loadLeague(pool, season);
  if (!current) throw new LineupError("No league for this season.", 404);
  if (current.commissioner_user_id !== userId) throw new LineupError("Only the commissioner can change league settings.", 403);
  const parsed = parseSettings(body, current.team_count, current.weeks.length);
  if ("error" in parsed) throw new LineupError(parsed.error, 400);
  const s = parsed.settings;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Postgres needs to know the zone too (it does the run-time math).
    const { rows: [tz] } = await client.query(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [s.timeZone]);
    if (!tz) throw new LineupError("Pick a time zone.", 400);

    // Locks the row so two saves don't interleave with the slot check.
    await client.query(`SELECT 1 FROM leagues WHERE id = $1 FOR UPDATE`, [current.id]);
    // A team using more IL slots than the new count would be stuck: refuse
    // rather than move players. Standing lineups and edits for today on.
    const { rows: over } = await client.query<{ name: string; slot: string; n: number }>(
      `WITH used AS (
         SELECT fantasy_team_id AS team_id, slot::text, count(*)::int AS n FROM roster_players
          WHERE league_id = $1 AND slot IN ('IL', 'IL+') GROUP BY 1, 2
         UNION ALL
         SELECT fantasy_team_id, slot::text, count(*)::int FROM lineup_slots
          WHERE league_id = $1 AND slot IN ('IL', 'IL+') AND locked_at IS NULL
            AND date >= (now() AT TIME ZONE $2)::date
          GROUP BY fantasy_team_id, date, slot)
       SELECT ft.name, u.slot, max(u.n)::int AS n FROM used u JOIN fantasy_teams ft ON ft.id = u.team_id
        WHERE u.n > CASE u.slot WHEN 'IL' THEN $3::int ELSE $4::int END
        GROUP BY ft.name, u.slot ORDER BY ft.name`,
      [current.id, current.time_zone, s.ilSlots, s.ilPlusSlots],
    );
    if (over.length > 0) {
      const list = over.map((o) => `${o.name} (${o.n} in ${o.slot})`).join(", ");
      throw new LineupError(`Some teams are using more IL slots than that: ${list}. They need to move those players first.`, 409);
    }

    // Playoff settings are fixed once bracket matchups exist, and the playoff
    // weeks can't already hold regular-season matchups.
    const playoffsChanged =
      s.playoffTeams !== current.playoff_teams || s.playoffStartWeek !== current.playoff_start_week ||
      s.toiletBowl !== current.toilet_bowl || s.toiletBowlTeams !== current.toilet_bowl_teams;
    if (playoffsChanged) {
      const { rows: [m] } = await client.query<{ started: boolean; regular: number | null }>(
        `SELECT bool_or(bracket IS NOT NULL) AS started, min(week) FILTER (WHERE bracket IS NULL AND week >= $2) AS regular
           FROM matchups WHERE league_id = $1`,
        [current.id, s.playoffStartWeek],
      );
      if (m?.started) throw new LineupError("The playoffs have started, so the playoff settings can't change.", 409);
      if (m?.regular != null) {
        throw new LineupError(`Week ${m.regular} has regular-season matchups, so the playoffs can't start in week ${s.playoffStartWeek}.`, 409);
      }
    }

    const slots: SlotCounts = { ...current.roster_slots, IL: s.ilSlots, "IL+": s.ilPlusSlots };
    for (const k of ["IL", "IL+"] as const) if (slots[k] === 0) delete slots[k];
    await client.query(
      `UPDATE leagues SET
         waiver_type = $2, waiver_time = $3::time, time_zone = $4, waiver_days_of_week = $5, waiver_days = $6,
         waivers_after_game_start = $7, roster_slots = $8, il_statuses = $9, il_min_days = $10,
         il_plus_statuses = $11, il_plus_min_days = $12, trade_review = $13, trade_review_days = $14,
         trade_veto_votes = $15, trade_deadline = $16, max_adds_per_week = $17, max_adds_per_season = $18,
         playoff_teams = $19, playoff_start_week = $20, toilet_bowl = $21, toilet_bowl_teams = $22,
         faab_budget = $23, faab_min_bid = $24, game_limits = $25, updated_at = now()
       WHERE id = $1`,
      [
        current.id, s.waiverType, s.waiverTime, s.timeZone, s.waiverDaysOfWeek, s.waiverDays,
        s.waiversAfterGameStart, JSON.stringify(slots), s.ilStatuses, s.ilMinDays,
        s.ilPlusStatuses, s.ilPlusMinDays, s.tradeReview, s.tradeReviewDays,
        s.tradeVetoVotes, s.tradeDeadline, s.maxAddsPerWeek, s.maxAddsPerSeason,
        s.playoffTeams, s.playoffStartWeek, s.toiletBowl, s.toiletBowlTeams,
        s.faabBudget, s.faabMinBid, s.gameLimits && JSON.stringify(s.gameLimits),
      ],
    );

    // Game limits start with the next matchup week: every week that hasn't
    // started takes the new ones; the current and past weeks keep theirs.
    if (JSON.stringify(s.gameLimits) !== JSON.stringify(toGameLimits(current.game_limits))) {
      await client.query(
        `UPDATE league_weeks SET game_limits = $2 WHERE league_id = $1 AND starts_on > (now() AT TIME ZONE $3)::date`,
        [current.id, s.gameLimits && JSON.stringify(s.gameLimits), current.time_zone],
      );
    }

    const toFaab = s.waiverType === "faab" && current.waiver_type !== "faab";
    if (toFaab) {
      await client.query(`UPDATE fantasy_teams SET faab_balance = $2 WHERE league_id = $1`, [current.id, s.faabBudget]);
      await client.query(
        `UPDATE transactions SET faab_bid = $2 WHERE league_id = $1 AND type = 'waiver_claim' AND status = 'pending'`,
        [current.id, s.faabMinBid],
      );
    } else if (s.waiverType === "faab" && s.faabBudget !== current.faab_budget) {
      await client.query(
        `UPDATE fantasy_teams SET faab_balance = greatest(0, coalesce(faab_balance, $3) + $2 - $3) WHERE league_id = $1`,
        [current.id, s.faabBudget, current.faab_budget],
      );
    } else if (s.waiverType !== "faab" && current.waiver_type === "faab") {
      await client.query(
        `UPDATE transactions SET faab_bid = NULL WHERE league_id = $1 AND type = 'waiver_claim' AND status = 'pending'`,
        [current.id],
      );
    }

    if (playoffsChanged) {
      await client.query(
        `UPDATE league_weeks SET is_playoffs = (week >= $2) WHERE league_id = $1 AND is_playoffs <> (week >= $2)`,
        [current.id, s.playoffStartWeek],
      );
    }

    const scheduleChanged =
      s.waiverTime !== current.waiver_time ||
      s.timeZone !== current.time_zone ||
      s.waiverDaysOfWeek.join() !== current.waiver_days_of_week.join();
    if (scheduleChanged) {
      // Still-future run times from the old schedule move to the first new run
      // at or after them (unchanged if that time is still a run).
      await client.query(
        `UPDATE transactions SET process_at = next_waiver_run(league_id, process_at - interval '1 microsecond')
          WHERE league_id = $1 AND type = 'waiver_claim' AND status = 'pending' AND process_at > now()`,
        [current.id],
      );
      await client.query(
        `UPDATE waiver_players SET clears_at = next_waiver_run(league_id, clears_at - interval '1 microsecond')
          WHERE league_id = $1 AND clears_at > now()`,
        [current.id],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return toResponse((await loadLeague(pool, season))!);
}

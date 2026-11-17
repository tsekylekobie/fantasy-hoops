// League settings: the rules on the leagues row (which the Yahoo sync keeps),
// shown read-only as "League rules" at /league/settings. parseSettings
// validates a whole LeagueSettings (the Yahoo import uses it).
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
import { ISO } from "./waiverStatus";

const WAIVER_TYPES: WaiverOrder["type"][] = ["continual_rolling", "reverse_standings", "faab"];
const TRADE_REVIEWS: TradeReview[] = ["none", "commissioner", "league_vote"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const LIMITS = {
  waiverDays: [0, 14],
  faabBudget: [1, 1000],
  ilSlots: [0, 5],
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
  all_adds_by_claim: boolean;
  faab_budget: number;
  faab_min_bid: number;
  roster_slots: SlotCounts;
  il_statuses: string[];
  il_plus_statuses: string[];
  claims_ignore_il_status: boolean;
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
            l.waiver_days, l.waivers_after_game_start, l.all_adds_by_claim, l.faab_budget, l.faab_min_bid, l.roster_slots, l.il_statuses,
            l.il_plus_statuses, l.claims_ignore_il_status, l.trade_review, l.trade_review_days, l.trade_veto_votes,
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
      allAddsByClaim: r.all_adds_by_claim,
      faabBudget: r.faab_budget,
      faabMinBid: r.faab_min_bid,
      ilSlots: r.roster_slots.IL ?? 0,
      ilStatuses: r.il_statuses,
      ilPlusSlots: r.roster_slots["IL+"] ?? 0,
      ilPlusStatuses: r.il_plus_statuses,
      claimsIgnoreIlStatus: r.claims_ignore_il_status,
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
  if (typeof b.allAddsByClaim !== "boolean") return { error: "allAddsByClaim must be true or false." };
  if (!isInt(b.faabBudget, LIMITS.faabBudget)) return { error: `The FAAB budget must be $${LIMITS.faabBudget.join("–$")}.` };
  if (!isInt(b.faabMinBid, [0, b.faabBudget])) return { error: `The minimum bid must be $0–$${b.faabBudget}.` };

  const il = statuses(b.ilStatuses);
  const ilPlus = statuses(b.ilPlusStatuses);
  if (!il || !ilPlus) return { error: `IL statuses must be from: ${INJURY_STATUSES.join(", ")}.` };
  for (const [label, slots, list] of [
    ["IL", b.ilSlots, il],
    ["IL+", b.ilPlusSlots, ilPlus],
  ] as const) {
    if (!isInt(slots, LIMITS.ilSlots)) return { error: `${label} slots must be ${LIMITS.ilSlots.join("–")}.` };
    if (slots > 0 && list.length === 0) return { error: `Pick at least one injury status that can use ${label}.` };
  }
  if (typeof b.claimsIgnoreIlStatus !== "boolean") return { error: "claimsIgnoreIlStatus must be true or false." };

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
      allAddsByClaim: b.allAddsByClaim,
      faabBudget: b.faabBudget,
      faabMinBid: b.faabMinBid,
      ilSlots: b.ilSlots as number,
      ilStatuses: il,
      ilPlusSlots: b.ilPlusSlots as number,
      ilPlusStatuses: ilPlus,
      claimsIgnoreIlStatus: b.claimsIgnoreIlStatus,
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

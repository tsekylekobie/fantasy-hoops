// Game limits: caps on how many games a team's starters play in one matchup
// week (league_weeks.game_limits). Pure functions (no DB) so they can be unit
// tested; matchup scoring (queries/matchups.ts) and the lineup's tally
// (queries/lineup.ts) both count with them.
//
// Rules: only starts count (BN, IL and IL+ never reach here). A team's starts
// are counted in tip-off order, ties broken by game id. A start counts while
// the team is under its total and the start's slot is under its cap (a slot's
// spots share one cap); once either is reached, later starts (for the team /
// in that slot) score nothing for the rest of the week. A start that doesn't
// count uses up nothing.
import { STARTING_SLOTS, type GameLimitUsage, type GameLimits, type LineupSlot } from "../types";

/** One start: a starter's NBA game on a day he was in a starting slot. */
export interface Start {
  slot: LineupSlot;
  /** The lineup's date, yyyy-mm-dd. */
  date: string;
  /** Tip-off, ISO timestamp; null when the schedule has no time (sorts last that day). */
  tipoff: string | null;
  gameId: number;
}

/** Whether a start counts, or which limit stopped it. */
export type StartOutcome = "counted" | "slot" | "total";

/** Tip-off order: by date, then tip-off time (unknown last), then game id. */
export function byTipoff(a: Start, b: Start): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.tipoff !== b.tipoff) {
    if (a.tipoff === null) return 1;
    if (b.tipoff === null) return -1;
    return Date.parse(a.tipoff) - Date.parse(b.tipoff);
  }
  return a.gameId - b.gameId;
}

/**
 * Each of one team's starts in a week, counted or stopped by a limit, in the
 * order given (any order; they're counted in tip-off order). No limits: all count.
 */
export function countStarts(starts: readonly Start[], limits: GameLimits | null): StartOutcome[] {
  const out: StartOutcome[] = starts.map(() => "counted");
  if (!limits) return out;
  const order = starts.map((_, i) => i).sort((i, j) => byTipoff(starts[i], starts[j]));
  let total = 0;
  const bySlot = new Map<LineupSlot, number>();
  for (const i of order) {
    const { slot } = starts[i];
    const cap = limits.slots[slot];
    const used = bySlot.get(slot) ?? 0;
    if (cap !== undefined && used >= cap) out[i] = "slot";
    else if (total >= limits.total) out[i] = "total";
    else {
      total++;
      bySlot.set(slot, used + 1);
    }
  }
  return out;
}

/**
 * A team's tally against its week's limits: `played` are starts already
 * played, `upcoming` starts in the lineups as set that haven't tipped off.
 * Null without limits.
 */
export function gameLimitUsage(
  played: readonly Start[], upcoming: readonly Start[], limits: GameLimits | null,
): GameLimitUsage | null {
  if (!limits) return null;
  const all = [...played, ...upcoming];
  const outcomes = countStarts(all, limits);
  const tally = (limit: number) => ({ limit, used: 0, planned: 0, blockedDays: [] as string[] });
  const total = tally(limits.total);
  const slots = STARTING_SLOTS.filter((s) => limits.slots[s] !== undefined).map((slot) => ({ slot, ...tally(limits.slots[slot]!) }));
  const block = (days: string[], day: string) => { if (!days.includes(day)) days.push(day); };
  all.forEach((s, i) => {
    const slot = slots.find((x) => x.slot === s.slot);
    const isPlayed = i < played.length;
    if (outcomes[i] === "counted") {
      total.planned++;
      if (isPlayed) total.used++;
      if (slot) {
        slot.planned++;
        if (isPlayed) slot.used++;
      }
    } else if (!isPlayed) {
      if (outcomes[i] === "slot") block(slot!.blockedDays, s.date);
      else block(total.blockedDays, s.date);
    }
  });
  total.blockedDays.sort();
  for (const s of slots) s.blockedDays.sort();
  return { total, slots };
}

/** Largest total and per-slot cap a commissioner can set. */
export const MAX_GAME_LIMIT = 200;

/**
 * Checks game limits from a request or the database: null (off), or a total
 * of 1–200 and per-slot caps of 0–200 on starting slots. Returns them with
 * the slots in display order, or an error for the commissioner.
 */
export function parseGameLimits(v: unknown): { limits: GameLimits | null } | { error: string } {
  if (v === null || v === undefined) return { limits: null };
  if (typeof v !== "object" || Array.isArray(v)) return { error: "Game limits must be an object or null." };
  const { total, slots } = v as Record<string, unknown>;
  const isCap = (n: unknown, min: number): n is number => Number.isInteger(n) && (n as number) >= min && (n as number) <= MAX_GAME_LIMIT;
  if (!isCap(total, 1)) return { error: `Total games per week must be 1–${MAX_GAME_LIMIT}.` };
  if (slots !== undefined && (typeof slots !== "object" || slots === null || Array.isArray(slots))) {
    return { error: "Per-position game limits must be an object." };
  }
  const given = (slots ?? {}) as Record<string, unknown>;
  for (const [slot, cap] of Object.entries(given)) {
    if (!STARTING_SLOTS.includes(slot as LineupSlot)) return { error: `${slot} isn't a starting slot.` };
    if (cap !== null && !isCap(cap, 0)) return { error: `The ${slot} game limit must be 0–${MAX_GAME_LIMIT} or blank.` };
  }
  const out: GameLimits["slots"] = {};
  for (const s of STARTING_SLOTS) if (typeof given[s] === "number") out[s] = given[s];
  return { limits: { total, slots: out } };
}

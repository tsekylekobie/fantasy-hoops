// Lineup rules: slot eligibility, validating a manager's lineup, and the
// auto-set optimizer. Pure functions (no DB) so they can be unit tested.
import { STARTING_SLOTS, type LineupSlot } from "../types";

export type SlotCounts = Partial<Record<LineupSlot, number>>;

const IL_SLOTS: LineupSlot[] = ["IL", "IL+"];

export function isStarting(slot: LineupSlot): boolean {
  return STARTING_SLOTS.includes(slot);
}

export interface IlSlotRule {
  /** Injury statuses (player_injuries.status) that qualify. */
  statuses: string[];
}

/** The league's IL eligibility rule (leagues.il_statuses and il_plus_statuses). */
export interface IlRules {
  il: IlSlotRule;
  ilPlus: IlSlotRule;
}

/**
 * THE IL eligibility rule: which IL slots a player may move into. A slot
 * qualifies when his current injury status (the latest report; null when
 * healthy) is one of its statuses.
 */
export function ilEligibility(status: string | null, il: IlRules): LineupSlot[] {
  if (status == null) return [];
  return ([["IL", il.il], ["IL+", il.ilPlus]] as const).filter(([, rule]) => rule.statuses.includes(status)).map(([slot]) => slot);
}

/** "Out or Day-To-Day" */
export function describeIlRule(rule: IlSlotRule): string {
  return rule.statuses.length > 0 ? rule.statuses.join(" or ") : "Nobody";
}

/**
 * Slots a player may hold. BALLDONTLIE positions are "G", "F", "C" or
 * combinations like "F-C"; a G fills PG/SG/G, an F fills SF/PF/F. Everyone
 * fits UTIL and BN; `ilSlots` comes from ilEligibility.
 */
export function eligibleSlots(position: string | null, ilSlots: LineupSlot[]): LineupSlot[] {
  const out = new Set<LineupSlot>(ilSlots);
  for (const p of (position ?? "").split("-")) {
    if (p === "G") (["PG", "SG", "G"] as const).forEach((s) => out.add(s));
    if (p === "F") (["SF", "PF", "F"] as const).forEach((s) => out.add(s));
    if (p === "C") out.add("C");
  }
  out.add("UTIL");
  out.add("BN");
  // Display order follows the slot list.
  return (["PG", "SG", "G", "SF", "PF", "F", "C", "UTIL", "BN", "IL", "IL+"] as const).filter((s) => out.has(s));
}

export const isIlSlot = (slot: LineupSlot) => IL_SLOTS.includes(slot);

/** Players a roster may hold outside IL: the league's non-IL slots, bench included. */
export function activeRosterLimit(counts: SlotCounts): number {
  return Object.entries(counts)
    .filter(([slot]) => !isIlSlot(slot as LineupSlot))
    .reduce((n, [, count]) => n + (count ?? 0), 0);
}

/**
 * Why a roster is illegal, as messages; empty when it's legal. Illegal =
 * someone on IL who no longer qualifies (he stays put, like Yahoo), or more
 * active players than the limit. The Yahoo import reports these.
 * `ilStatus: false` leaves out the IL check.
 */
export function rosterProblems(
  players: { id: number; slot: LineupSlot; eligible: LineupSlot[]; name: string }[],
  counts: SlotCounts,
  { ilStatus = true }: { ilStatus?: boolean } = {},
): string[] {
  const out: string[] = [];
  for (const p of players) {
    if (ilStatus && isIlSlot(p.slot) && !p.eligible.includes(p.slot)) {
      out.push(`${p.name} is on ${p.slot} but no longer qualifies. Move him to the bench (if the roster is full, drop someone first) or drop him.`);
    }
  }
  const active = players.filter((p) => !isIlSlot(p.slot)).length;
  const limit = activeRosterLimit(counts);
  if (active > limit) out.push(`${active} active players; the limit is ${limit} not counting IL. Drop a player or move one to IL.`);
  return out;
}

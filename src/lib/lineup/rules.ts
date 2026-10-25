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
  /** Days he must have been listed with a qualifying status, without a break. 0 = right away. */
  minDays: number;
}

/** The league's IL eligibility rule (leagues.il_statuses, il_min_days, and the IL+ pair). */
export interface IlRules {
  il: IlSlotRule;
  ilPlus: IlSlotRule;
}

/**
 * One injury report entry from the player's current stint on the report
 * (since he was last off it), oldest first. `date` is the league-local day it
 * was observed, yyyy-mm-dd.
 */
export interface InjuryReport {
  status: string;
  date: string;
}

const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

/**
 * THE IL eligibility rule: which IL slots a player may move into on `onDate`.
 * A slot qualifies when his current status is one of its statuses and he's
 * been listed with one of them, without a break, for at least its minDays.
 * An empty stint means he's healthy.
 */
export function ilEligibility(stint: InjuryReport[], il: IlRules, onDate: string): LineupSlot[] {
  const out: LineupSlot[] = [];
  for (const [slot, rule] of [["IL", il.il], ["IL+", il.ilPlus]] as const) {
    let i = stint.length - 1;
    if (i < 0 || !rule.statuses.includes(stint[i].status)) continue;
    while (i > 0 && rule.statuses.includes(stint[i - 1].status)) i--;
    const days = Math.max(0, dayNumber(onDate) - dayNumber(stint[i].date));
    if (days >= rule.minDays) out.push(slot);
  }
  return out;
}

/** "Out, 3+ days on the injury report" */
export function describeIlRule(rule: IlSlotRule): string {
  const statuses = rule.statuses.length > 0 ? rule.statuses.join(" or ") : "Nobody";
  return rule.minDays > 0 ? `${statuses}, ${rule.minDays}+ day${rule.minDays > 1 ? "s" : ""} on the injury report` : statuses;
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
 * Why a roster is illegal, as messages for the manager; empty when it's
 * legal. Illegal = someone on IL who no longer qualifies (he stays put, like
 * Yahoo), or more active players than the limit. While illegal, a team can't
 * add players or place waiver claims; drops and lineup moves still work.
 */
export function rosterProblems(
  players: { id: number; slot: LineupSlot; eligible: LineupSlot[]; name: string }[],
  counts: SlotCounts,
): string[] {
  const out: string[] = [];
  for (const p of players) {
    if (isIlSlot(p.slot) && !p.eligible.includes(p.slot)) {
      out.push(`${p.name} is on ${p.slot} but no longer qualifies. Move him to the bench (if the roster is full, drop someone first) or drop him.`);
    }
  }
  const active = players.filter((p) => !isIlSlot(p.slot)).length;
  const limit = activeRosterLimit(counts);
  if (active > limit) out.push(`${active} active players; the limit is ${limit} not counting IL. Drop a player or move one to IL.`);
  return out;
}

export interface RulePlayer {
  id: number;
  slot: LineupSlot;
  eligible: LineupSlot[];
  locked: boolean;
}

/**
 * Checks a proposed lineup (player id -> slot) against the current one.
 * Returns an error message, or null when it's allowed. A player who stays in
 * his slot is always fine, even if he no longer qualifies for it (e.g. an IL
 * player who got healthy: rosterProblems flags that); slot counts only fail
 * when a move overfills a slot or the active roster.
 */
export function validateLineup(
  players: RulePlayer[],
  next: Map<number, LineupSlot>,
  counts: SlotCounts,
  names: Map<number, string>,
): string | null {
  if (next.size !== players.length || players.some((p) => !next.has(p.id))) {
    return "The lineup doesn't match your roster. Reload and try again.";
  }
  const before = new Map<LineupSlot, number>();
  const after = new Map<LineupSlot, number>();
  for (const p of players) {
    const slot = next.get(p.id)!;
    before.set(p.slot, (before.get(p.slot) ?? 0) + 1);
    after.set(slot, (after.get(slot) ?? 0) + 1);
    if (slot === p.slot) continue;
    const name = names.get(p.id) ?? "That player";
    if (p.locked) return `${name} is locked and can't be moved.`;
    if (!p.eligible.includes(slot)) {
      return IL_SLOTS.includes(slot)
        ? `${name} isn't eligible for ${slot} (league setting).`
        : `${name} can't play ${slot}.`;
    }
  }
  // Moving someone off IL can't push the active roster past the limit.
  const active = (m: Map<LineupSlot, number>) => [...m].reduce((n, [s, c]) => n + (isIlSlot(s) ? 0 : c), 0);
  const limit = activeRosterLimit(counts);
  if (active(after) > limit && active(after) > active(before)) {
    return `Your roster is full (${limit} not counting IL). Drop a player before moving someone off IL.`;
  }
  for (const [slot, n] of after) {
    if (slot === "BN") continue; // the bench grows as needed; the active limit above caps it
    const limit = counts[slot] ?? 0;
    if (n > limit && n > (before.get(slot) ?? 0)) {
      return limit === 0 ? `This league has no ${slot} slot.` : `Only ${limit} ${slot} slot${limit > 1 ? "s" : ""}.`;
    }
  }
  return null;
}

export interface AutoPlayer extends RulePlayer {
  /** Has a game that day and isn't listed Out. */
  plays: boolean;
  /** 9CAT value; higher starts first. */
  value: number;
}

// Weights, lexicographic: most starters with a game, then the best of them,
// then the fewest moves.
const PLAYS = 1_000_000;
const VALUE = 1_000;
const STAY = 1;
// Keeps value weights positive so a playing player always beats an empty slot.
const VALUE_FLOOR = 100;

function weight(p: AutoPlayer, slot: LineupSlot): number {
  let w = p.slot === slot ? STAY : 0;
  if (isStarting(slot) && p.plays) w += PLAYS + VALUE * (Math.max(p.value, -VALUE_FLOOR) + VALUE_FLOOR);
  return w;
}

/**
 * The best lineup for one day: start as many players with games as possible,
 * preferring higher value, and move as few players as needed. Locked players
 * and anyone on an IL slot stay put; their slots are taken out of the pool.
 * Exact: a DP over the remaining open count of each starting slot type
 * (at most a few hundred states for a standard roster).
 */
export function autoLineup(players: AutoPlayer[], counts: SlotCounts): Map<number, LineupSlot> {
  const out = new Map<number, LineupSlot>();
  const open = new Map<LineupSlot, number>(STARTING_SLOTS.map((s) => [s, counts[s] ?? 0]));
  const movable: AutoPlayer[] = [];
  for (const p of players) {
    if (p.locked || IL_SLOTS.includes(p.slot)) {
      out.set(p.id, p.slot);
      if (open.has(p.slot)) open.set(p.slot, open.get(p.slot)! - 1);
    } else {
      movable.push(p);
    }
  }

  const types = STARTING_SLOTS.filter((s) => (open.get(s) ?? 0) > 0);
  const start = types.map((s) => open.get(s)!);
  const key = (v: number[]) => v.join(",");

  // layers[i]: state after deciding the first i movable players.
  type Node = { caps: number[]; score: number; prev: string | null; slot: LineupSlot | null };
  let layer = new Map<string, Node>([[key(start), { caps: start, score: 0, prev: null, slot: null }]]);
  const layers: Map<string, Node>[] = [layer];
  for (const p of movable) {
    const nextLayer = new Map<string, Node>();
    const offer = (k: string, n: Node) => {
      const cur = nextLayer.get(k);
      if (!cur || n.score > cur.score) nextLayer.set(k, n);
    };
    for (const [k, node] of layer) {
      offer(k, { caps: node.caps, score: node.score + weight(p, "BN"), prev: k, slot: "BN" });
      types.forEach((t, i) => {
        if (node.caps[i] === 0 || !p.eligible.includes(t)) return;
        const caps = node.caps.slice();
        caps[i]--;
        offer(key(caps), { caps, score: node.score + weight(p, t), prev: k, slot: t });
      });
    }
    layer = nextLayer;
    layers.push(layer);
  }

  // Best end state. The bench has no fixed size, so every state is feasible.
  let best: [string, Node] = [...layer][0];
  for (const entry of layer) if (entry[1].score > best[1].score) best = entry;
  let k: string | null = best[0];
  for (let i = movable.length; i > 0; i--) {
    const node: Node = layers[i].get(k!)!;
    out.set(movable[i - 1].id, node.slot!);
    k = node.prev;
  }
  return out;
}

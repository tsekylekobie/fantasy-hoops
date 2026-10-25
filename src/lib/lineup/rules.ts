// Lineup rules: slot eligibility, validating a manager's lineup, and the
// auto-set optimizer. Pure functions (no DB) so they can be unit tested.
import { STARTING_SLOTS, type LineupSlot } from "../types";

export type SlotCounts = Partial<Record<LineupSlot, number>>;

const IL_SLOTS: LineupSlot[] = ["IL", "IL+"];

export function isStarting(slot: LineupSlot): boolean {
  return STARTING_SLOTS.includes(slot);
}

export interface IlRules {
  /** Injury statuses that may use IL / IL+ (league settings). */
  il: string[];
  ilPlus: string[];
}

/**
 * Slots a player may hold. BALLDONTLIE positions are "G", "F", "C" or
 * combinations like "F-C"; a G fills PG/SG/G, an F fills SF/PF/F. Everyone
 * fits UTIL and BN; IL slots depend on the injury status and league rules.
 */
export function eligibleSlots(position: string | null, injuryStatus: string | null, il: IlRules): LineupSlot[] {
  const out = new Set<LineupSlot>();
  for (const p of (position ?? "").split("-")) {
    if (p === "G") (["PG", "SG", "G"] as const).forEach((s) => out.add(s));
    if (p === "F") (["SF", "PF", "F"] as const).forEach((s) => out.add(s));
    if (p === "C") out.add("C");
  }
  out.add("UTIL");
  out.add("BN");
  if (injuryStatus && il.il.includes(injuryStatus)) out.add("IL");
  if (injuryStatus && il.ilPlus.includes(injuryStatus)) out.add("IL+");
  // Display order follows the slot list.
  return (["PG", "SG", "G", "SF", "PF", "F", "C", "UTIL", "BN", "IL", "IL+"] as const).filter((s) => out.has(s));
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
 * player who got healthy); slot counts only fail when a move overfills a slot.
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
  for (const [slot, n] of after) {
    if (slot === "BN") continue; // the bench grows as needed; roster size is capped by adds, not lineups
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

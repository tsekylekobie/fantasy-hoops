// Run: npx tsx --test src/lib/lineup/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LineupSlot } from "../types";
import {
  autoLineup,
  eligibleSlots,
  ilEligibility,
  rosterProblems,
  validateLineup,
  type AutoPlayer,
  type IlRules,
  type SlotCounts,
} from "./rules";

const IL: IlRules = { il: { statuses: ["Out"] }, ilPlus: { statuses: ["Out", "Day-To-Day"] } };
const COUNTS: SlotCounts = { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 2, UTIL: 2, BN: 3, IL: 2 };

function p(id: number, position: string, slot: LineupSlot, over: Partial<AutoPlayer> = {}): AutoPlayer {
  return { id, slot, eligible: eligibleSlots(position, []), locked: false, plays: true, value: 0, ...over };
}

test("eligibility: G-F fills guard and forward slots, IL needs an Out status", () => {
  assert.deepEqual(eligibleSlots("G-F", ilEligibility(null, IL)), ["PG", "SG", "G", "SF", "PF", "F", "UTIL", "BN"]);
  assert.deepEqual(eligibleSlots("C", ilEligibility("Out", IL)), ["C", "UTIL", "BN", "IL", "IL+"]);
  assert.deepEqual(eligibleSlots("C", ilEligibility("Day-To-Day", IL)), ["C", "UTIL", "BN", "IL+"]);
  assert.deepEqual(eligibleSlots(null, []), ["UTIL", "BN"]);
});

test("IL rule: only the current status counts", () => {
  assert.deepEqual(ilEligibility("Out", IL), ["IL", "IL+"]);
  assert.deepEqual(ilEligibility("Day-To-Day", IL), ["IL+"]);
  assert.deepEqual(ilEligibility("Probable", IL), []);
  assert.deepEqual(ilEligibility(null, IL), []);
  // A league with no qualifying statuses: nobody, whatever his status.
  assert.deepEqual(ilEligibility("Out", { il: { statuses: [] }, ilPlus: { statuses: [] } }), []);
});

test("roster problems: a healthy player on IL, and too many active players", () => {
  const counts: SlotCounts = { C: 1, BN: 1, IL: 1 };
  const roster = [
    { id: 1, slot: "C" as const, eligible: eligibleSlots("C", []), name: "Ann" },
    { id: 2, slot: "IL" as const, eligible: eligibleSlots("C", ["IL"]), name: "Bo" },
  ];
  assert.deepEqual(rosterProblems(roster, counts), []);
  roster[1].eligible = eligibleSlots("C", []);
  assert.match(rosterProblems(roster, counts)[0], /Bo is on IL but no longer qualifies/);
  const crowded = [...roster.slice(0, 1), { id: 3, slot: "BN" as const, eligible: eligibleSlots("C", []), name: "Cy" }, { id: 4, slot: "BN" as const, eligible: eligibleSlots("C", []), name: "Di" }];
  assert.match(rosterProblems(crowded, counts)[0], /3 active players; the limit is 2/);
});

test("validate: moving a player off IL can't overfill the active roster", () => {
  const players = [p(1, "C", "C"), p(2, "C", "BN"), p(3, "C", "IL")];
  const names = new Map<number, string>();
  assert.match(validateLineup(players, new Map([[1, "C"], [2, "BN"], [3, "BN"]]), { C: 1, BN: 1, IL: 1 }, names)!, /roster is full \(2 not counting IL\)/);
  assert.equal(validateLineup(players, new Map([[1, "C"], [2, "BN"], [3, "BN"]]), { C: 1, BN: 2, IL: 1 }, names), null);
});

test("validate: a healthy player stashed on IL stays put while the rest of the lineup moves", () => {
  // Bo got healthy on IL: the roster is illegal (no adds), but lineup moves still work.
  const players = [p(1, "C", "C"), p(2, "C", "BN"), p(3, "C", "IL")];
  const counts: SlotCounts = { C: 1, BN: 1, IL: 1 };
  const names = new Map([[3, "Bo"]]);
  assert.match(rosterProblems(players.map((x) => ({ ...x, name: names.get(x.id) ?? "" })), counts)[0], /Bo is on IL but no longer qualifies/);
  assert.equal(validateLineup(players, new Map([[1, "BN"], [2, "C"], [3, "IL"]]), counts, names), null);
  // He can't go back on IL once he's off it, or into a full active roster.
  assert.match(validateLineup(players, new Map([[1, "C"], [2, "BN"], [3, "BN"]]), counts, names)!, /roster is full/);
  assert.deepEqual(autoLineup(players.map((x) => ({ ...x, plays: true })), counts).get(3), "IL");
});

test("validate: swapping a starter and a bench player", () => {
  const players = [p(1, "C", "C"), p(2, "C", "BN")];
  const names = new Map<number, string>();
  assert.equal(validateLineup(players, new Map([[1, "BN"], [2, "C"]]), COUNTS, names), null);
});

test("validate: locked players can't move, positions are enforced, slots can't overfill", () => {
  const names = new Map([[1, "Ann"], [2, "Bo"]]);
  const locked = [p(1, "C", "C", { locked: true }), p(2, "C", "BN")];
  assert.match(validateLineup(locked, new Map([[1, "BN"], [2, "C"]]), COUNTS, names)!, /Ann is locked/);
  const guard = [p(1, "G", "BN"), p(2, "C", "C")];
  assert.match(validateLineup(guard, new Map([[1, "C"], [2, "BN"]]), COUNTS, names)!, /can't play C/);
  const two = [p(1, "G", "PG"), p(2, "G", "BN")];
  assert.match(validateLineup(two, new Map([[1, "PG"], [2, "PG"]]), COUNTS, names)!, /Only 1 PG slot/);
  assert.match(validateLineup(two, new Map([[1, "PG"]]), COUNTS, names)!, /doesn't match your roster/);
});

test("auto: a bench player with a game replaces a starter without one", () => {
  const out = autoLineup([p(1, "C", "C", { plays: false }), p(2, "C", "BN")], { C: 1, BN: 1 });
  assert.equal(out.get(1), "BN");
  assert.equal(out.get(2), "C");
});

test("auto: more players than slots starts the best values, and reshuffles positions to fit everyone", () => {
  // G-F must move to SF so the pure guard can start at PG.
  const players = [p(1, "G-F", "PG", { value: 5 }), p(2, "G", "BN", { value: 4 }), p(3, "F", "BN", { value: 1 })];
  const out = autoLineup(players, { PG: 1, SF: 1, BN: 2 });
  assert.equal(out.get(1), "SF");
  assert.equal(out.get(2), "PG");
  assert.equal(out.get(3), "BN");
});

test("auto: locked and IL players stay; their slots aren't reused", () => {
  const players = [
    p(1, "C", "C", { locked: true, plays: false }),
    p(2, "C", "BN"),
    p(3, "C", "IL", { plays: false }),
  ];
  const out = autoLineup(players, { C: 1, BN: 1, IL: 1 });
  assert.deepEqual([out.get(1), out.get(2), out.get(3)], ["C", "BN", "IL"]);
});

test("auto: nothing changes when the lineup is already best", () => {
  const players = [p(1, "C", "C", { value: 3 }), p(2, "C", "BN", { plays: false, value: 9 })];
  const out = autoLineup(players, { C: 1, BN: 1 });
  assert.deepEqual([out.get(1), out.get(2)], ["C", "BN"]);
});

test("auto: the bench takes whoever is displaced, past its listed size", () => {
  const players = [p(1, "G", "BN"), p(2, "G", "BN", { plays: false }), p(3, "G", "PG", { plays: false })];
  const out = autoLineup(players, { PG: 1, BN: 1 });
  assert.deepEqual([out.get(1), out.get(2), out.get(3)], ["PG", "BN", "BN"]);
});

test("validate: moving to a full bench is allowed (no swap needed); other slots stay capped", () => {
  const players = [p(1, "C", "C"), p(2, "C", "BN"), p(3, "C", "BN")];
  const names = new Map<number, string>();
  assert.equal(validateLineup(players, new Map([[1, "BN"], [2, "BN"], [3, "BN"]]), { C: 1, BN: 2 }, names), null);
  assert.match(validateLineup(players, new Map([[1, "C"], [2, "C"], [3, "BN"]]), { C: 1, BN: 2 }, names)!, /Only 1 C slot/);
});

// Run: npx tsx --test src/lib/lineup/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { eligibleSlots, ilEligibility, rosterProblems, type IlRules, type SlotCounts } from "./rules";

const IL: IlRules = { il: { statuses: ["Out"] }, ilPlus: { statuses: ["Out", "Day-To-Day"] } };
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
  // Without the IL check, only the active limit counts.
  assert.deepEqual(rosterProblems(roster, counts, { ilStatus: false }), []);
  assert.match(rosterProblems(crowded, counts, { ilStatus: false })[0], /3 active players/);
});

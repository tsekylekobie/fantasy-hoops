// Run: npx tsx --test src/components/matchup/margin.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchupMargin } from "./margin";

const score = (wins: number, losses: number, ties: number) => ({ wins, losses, ties });

test("no margin before a category is decided", () => {
  assert.equal(matchupMargin(score(0, 0, 9)), null);
});

test("a level score with decided categories is tied", () => {
  assert.deepEqual(matchupMargin(score(4, 4, 1)), { margin: 0, leader: null, tier: "tied", label: "Tied" });
});

test("tiers follow the gap in categories", () => {
  const tier = (w: number, l: number, t: number) => matchupMargin(score(w, l, t))?.tier;
  assert.equal(tier(5, 4, 0), "close");
  assert.equal(tier(5, 3, 1), "close");
  assert.equal(tier(6, 3, 0), "clear");
  assert.equal(tier(5, 1, 3), "clear");
  assert.equal(tier(7, 2, 0), "blowout");
  assert.equal(tier(9, 0, 0), "blowout");
});

test("the leader can be either side, with the same margin", () => {
  assert.deepEqual(matchupMargin(score(7, 2, 0)), { margin: 5, leader: "team", tier: "blowout", label: "Blowout · by 5" });
  assert.deepEqual(matchupMargin(score(2, 7, 0)), { margin: 5, leader: "opponent", tier: "blowout", label: "Blowout · by 5" });
});

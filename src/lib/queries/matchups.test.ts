// Run: npx tsx --test src/lib/queries/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CategoryLine } from "../types";
import { compareLines } from "./matchups";

function line(over: Partial<CategoryLine> = {}): CategoryLine {
  return {
    fgm: 45, fga: 100, fgPct: 0.45, ftm: 20, fta: 25, ftPct: 0.8, fg3m: 12,
    pts: 120, reb: 50, ast: 30, stl: 8, blk: 5, tov: 15, ...over,
  };
}

test("equal lines tie every category", () => {
  assert.deepEqual(compareLines(line(), line()).score, { wins: 0, losses: 0, ties: 9 });
});

test("fewer turnovers win TO; more of anything else wins", () => {
  const { results, score } = compareLines(line({ tov: 10, pts: 100 }), line());
  assert.equal(results.tov, "win");
  assert.equal(results.pts, "loss");
  assert.deepEqual(score, { wins: 1, losses: 1, ties: 7 });
});

test("no attempts loses the percentage to a side with attempts, ties another with none", () => {
  assert.equal(compareLines(line({ fgPct: null }), line()).results.fgPct, "loss");
  assert.equal(compareLines(line({ fgPct: null }), line({ fgPct: null })).results.fgPct, "tie");
});

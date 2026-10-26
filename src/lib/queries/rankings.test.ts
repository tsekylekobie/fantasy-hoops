// Run: npx tsx --test src/lib/queries/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CategoryLine } from "../types";
import { addLines, allPlay, categoryRanks } from "./rankings";

function line(over: Partial<CategoryLine> = {}): CategoryLine {
  return {
    fgm: 45, fga: 100, fgPct: 0.45, ftm: 20, fta: 25, ftPct: 0.8, fg3m: 12,
    pts: 120, reb: 50, ast: 30, stl: 8, blk: 5, tov: 15, ...over,
  };
}

test("added lines take percentages from summed makes and attempts, not an average", () => {
  const sum = addLines(line({ fgm: 9, fga: 10, fgPct: 0.9 }), line({ fgm: 10, fga: 90, fgPct: 0.111 }));
  assert.equal(sum.fgm, 19);
  assert.equal(sum.fga, 100);
  assert.equal(sum.fgPct, 0.19);
  assert.equal(sum.pts, 240);
  assert.equal(addLines(line({ fta: 0, ftm: 0 }), line({ fta: 0, ftm: 0 })).ftPct, null);
});

test("all-play compares every team with every other team", () => {
  const lines = new Map([
    [1, line({ pts: 200 })],
    [2, line()],
    [3, line({ pts: 100 })],
  ]);
  const ap = allPlay([1, 2, 3], lines);
  assert.deepEqual(ap.get(1)!.record, { wins: 2, losses: 0, ties: 16 });
  assert.deepEqual(ap.get(3)!.record, { wins: 0, losses: 2, ties: 16 });
  assert.deepEqual(ap.get(2)!.vs.get(1)!.score, { wins: 0, losses: 1, ties: 8 });
  assert.equal(ap.get(1)!.vs.has(1), false);
});

test("a team with no games yet plays an empty line", () => {
  const ap = allPlay([1, 2], new Map([[1, line()]]));
  assert.equal(ap.get(2)!.record.wins, 1); // fewer turnovers
  assert.equal(ap.get(2)!.record.losses, 8);
});

test("category ranks: fewest turnovers is first, ties share a place, no attempts is last", () => {
  const lines = new Map([
    [1, line({ tov: 10, reb: 60, fgPct: null, fga: 0, fgm: 0 })],
    [2, line({ tov: 20, reb: 60 })],
    [3, line({ tov: 15, reb: 40 })],
  ]);
  const r = categoryRanks([1, 2, 3], lines);
  assert.deepEqual([r.get(1)!.tov, r.get(3)!.tov, r.get(2)!.tov], [1, 2, 3]);
  assert.deepEqual([r.get(1)!.reb, r.get(2)!.reb, r.get(3)!.reb], [1, 1, 3]);
  assert.equal(r.get(1)!.fgPct, 3);
});

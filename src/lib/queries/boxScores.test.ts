// Run: npx tsx --test src/lib/queries/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Category, CategoryLine } from "../types";
import { rankDay, tierOf, type RankInput } from "./boxScores";

const Z0 = { fgPct: 0, ftPct: 0, fg3m: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0 } as Record<Category, number>;

function input(key: number, over: Partial<CategoryLine> = {}, z: Partial<Record<Category, number>> = {}, value = 0): RankInput {
  const line: CategoryLine = {
    fgm: 5, fga: 10, fgPct: 0.5, ftm: 2, fta: 2, ftPct: 1, fg3m: 1, pts: 13, reb: 4, ast: 3, stl: 1, blk: 0, tov: 2, ...over,
  };
  return { key, line, score: { z: { ...Z0, ...z }, value } };
}

test("the day's top scorer ranks first and lands in the top tier", () => {
  const lines = Array.from({ length: 20 }, (_, i) => input(i, { pts: i }));
  const ranks = rankDay(lines);
  assert.deepEqual(ranks.get(19)!.pts, { rank: 1, tied: false, tier: "top10" });
  assert.equal(ranks.get(0)!.pts!.tier, "bottom10");
  assert.equal(ranks.get(0)!.pts!.rank, 20);
});

test("ties share the best rank and the middle of the tie decides the tier", () => {
  // 1 player with 3 blocks, 9 with 0: the zeros sit in the middle-to-bottom, not at the top.
  const lines = [input(0, { blk: 3 }), ...Array.from({ length: 9 }, (_, i) => input(i + 1, { blk: 0 }))];
  const ranks = rankDay(lines);
  assert.deepEqual(ranks.get(0)!.blk, { rank: 1, tied: false, tier: "top10" });
  assert.deepEqual(ranks.get(5)!.blk, { rank: 2, tied: true, tier: "mid" });
});

test("fewer turnovers ranks higher", () => {
  const ranks = rankDay([input(0, { tov: 0 }), input(1, { tov: 6 })]);
  assert.equal(ranks.get(0)!.tov!.rank, 1);
  assert.equal(ranks.get(1)!.tov!.rank, 2);
});

test("FG% ranks by impact (the z), and no attempts means no rank", () => {
  const ranks = rankDay([
    input(0, { fgm: 1, fga: 1, fgPct: 1 }, { fgPct: 0.4 }),
    input(1, { fgm: 8, fga: 10, fgPct: 0.8 }, { fgPct: 1.5 }),
    input(2, { fgm: 0, fga: 0, fgPct: null }),
  ]);
  assert.equal(ranks.get(1)!.fgPct!.rank, 1);
  assert.equal(ranks.get(0)!.fgPct!.rank, 2);
  assert.equal(ranks.get(2)!.fgPct, undefined);
});

test("tiers", () => {
  assert.equal(tierOf(0), "top10");
  assert.equal(tierOf(0.2), "top25");
  assert.equal(tierOf(0.4), "top40");
  assert.equal(tierOf(0.5), "mid");
  assert.equal(tierOf(0.8), "bottom25");
  assert.equal(tierOf(1), "bottom10");
});

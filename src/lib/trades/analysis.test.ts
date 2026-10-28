// Run: npx tsx --test src/lib/trades/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LineupSlot, PerGameLine, TradeAnalysisPlayer, TradeAnalysisResponse } from "../types";
import { DEFAULT_WEIGHTS } from "../types";
import { analyzeTrade, bestLineup, emptyPerGame } from "./analysis";

function line(over: Partial<PerGameLine> = {}): PerGameLine {
  return { ...emptyPerGame(), fgm: 5, fga: 10, ftm: 2, fta: 3, fg3m: 1, pts: 13, reb: 5, ast: 3, stl: 1, blk: 0.5, tov: 1.5, ...over };
}

function player(id: number, position: string, value: number, over: Partial<PerGameLine> = {}, slot: LineupSlot = "BN"): TradeAnalysisPlayer {
  const l = { gp: 10, perGame: line(over), value, defaultValue: value / 2 };
  return {
    id, firstName: "P", lastName: String(id), teamAbbr: null, position, nbaPersonId: null, slot,
    season: l, last14: { ...l, perGame: line({ ...over, pts: (over.pts ?? 13) + 5 }), value: value + 1 },
  };
}

function data(a: TradeAnalysisPlayer[], b: TradeAnalysisPlayer[], others: PerGameLine[] = [], activeLimit = 4): TradeAnalysisResponse {
  return {
    activeLimit,
    slots: [{ slot: "G", count: 1 }, { slot: "F", count: 1 }, { slot: "C", count: 1 }],
    weights: DEFAULT_WEIGHTS,
    weightsAreDefault: true,
    teams: [
      { id: 1, name: "A", abbreviation: "A", logoUrl: null, players: a },
      { id: 2, name: "B", abbreviation: "B", logoUrl: null, players: b },
    ],
    league: [
      { teamId: 1, season: emptyPerGame(), last14: emptyPerGame() },
      { teamId: 2, season: emptyPerGame(), last14: emptyPerGame() },
      ...others.map((l, i) => ({ teamId: 10 + i, season: l, last14: l })),
    ],
    last14: null,
  };
}

test("team percentages come from summed makes and attempts, and TO is better when lower", () => {
  // A trades a 9/10 shooter with 4 TO for a 1/10 shooter with 0 TO.
  const a = [player(1, "G", 1, { fgm: 9, fga: 10, tov: 4 }), player(2, "F", 1, { fgm: 1, fga: 10 })];
  const b = [player(3, "C", 1, { fgm: 1, fga: 10, tov: 0 })];
  const [sa] = analyzeTrade(data(a, b), [{ teamId: 1, out: [1], drops: [] }, { teamId: 2, out: [3], drops: [] }], "season", "mine");
  const fg = sa.categories.find((c) => c.key === "fgPct")!;
  assert.equal(fg.before, 10 / 20);
  assert.equal(fg.after, 2 / 20);
  assert.equal(fg.better, false);
  const to = sa.categories.find((c) => c.key === "tov")!;
  assert.equal(to.before, 5.5);
  assert.equal(to.after, 1.5);
  assert.equal(to.better, true);
});

test("ranks place both teams against the rest of the league, before and after", () => {
  const a = [player(1, "G", 1, { pts: 30 }), player(2, "F", 1, { pts: 10 })];
  const b = [player(3, "C", 1, { pts: 5 }), player(4, "F", 1, { pts: 5 })];
  const others = [line({ pts: 25 }), line({ pts: 15 })];
  const [sa, sb] = analyzeTrade(
    data(a, b, others), [{ teamId: 1, out: [1], drops: [] }, { teamId: 2, out: [3], drops: [] }], "season", "mine",
  );
  const pa = sa.categories.find((c) => c.key === "pts")!, pb = sb.categories.find((c) => c.key === "pts")!;
  // Before: A 40, others 25 and 15, B 10. After: B 35, A 15 (tied with an other team).
  assert.deepEqual([pa.rankBefore, pa.rankAfter], [1, 3]);
  assert.deepEqual([pb.rankBefore, pb.rankAfter], [4, 1]);
});

test("a team over the active limit drops its picks first, then its lowest-value players", () => {
  const a = [player(1, "G", 3), player(2, "F", 0.5), player(3, "C", 2), player(4, "G", -1)];
  const b = [player(5, "G", 1), player(6, "F", 1), player(7, "C", 1)];
  const sides = (drops: number[]) => [{ teamId: 1, out: [1], drops }, { teamId: 2, out: [5, 6], drops: [] }] as [never, never];
  const [none] = analyzeTrade(data(a, b), sides([]), "season", "mine");
  assert.equal(none.activeAfter, 5);
  assert.equal(none.mustDrop, 1);
  assert.deepEqual(none.drops.map((d) => [d.player.id, d.assumed]), [[4, true]]);
  const [picked] = analyzeTrade(data(a, b), sides([3]), "season", "mine");
  assert.deepEqual(picked.drops.map((d) => [d.player.id, d.assumed]), [[3, false]]);
  assert.equal(picked.valueAfter, 0.5 - 1 + 1 + 1);
  // A player it gives up can't also be a drop.
  const [traded] = analyzeTrade(data(a, b), sides([1]), "season", "mine");
  assert.deepEqual(traded.drops.map((d) => d.player.id), [4]);
});

test("IL players stay out of the totals and the active count but keep their value", () => {
  const a = [player(1, "G", 1, { pts: 10 }), player(2, "C", 2, { pts: 40 }, "IL")];
  const b = [player(3, "F", 1, { pts: 20 })];
  const [sa] = analyzeTrade(data(a, b), [{ teamId: 1, out: [1], drops: [] }, { teamId: 2, out: [3], drops: [] }], "season", "mine");
  const pts = sa.categories.find((c) => c.key === "pts")!;
  assert.deepEqual([pts.before, pts.after], [10, 20]);
  assert.deepEqual([sa.activeBefore, sa.activeAfter], [1, 1]);
  assert.deepEqual([sa.valueBefore, sa.valueAfter], [3, 3]);
});

test("the window and weights pick each player's line and value", () => {
  const a = [player(1, "G", 2)];
  const b = [player(2, "F", 1)];
  const sides = [{ teamId: 1, out: [1], drops: [] }, { teamId: 2, out: [2], drops: [] }] as [never, never];
  const [season] = analyzeTrade(data(a, b), sides, "season", "default");
  assert.deepEqual([season.valueBefore, season.valueAfter], [1, 0.5]);
  const [l14] = analyzeTrade(data(a, b), sides, "last14", "mine");
  assert.deepEqual([l14.valueBefore, l14.valueAfter], [3, 2]);
  assert.equal(l14.categories.find((c) => c.key === "pts")!.before, 18);
});

test("losing the only center leaves the C slot empty", () => {
  const a = [player(1, "G", 1), player(2, "F", 1), player(3, "C", 1)];
  const b = [player(4, "G", 1), player(5, "F", 1), player(6, "F-C", 1)];
  const [sa] = analyzeTrade(data(a, b), [{ teamId: 1, out: [3], drops: [] }, { teamId: 2, out: [4], drops: [] }], "season", "mine");
  assert.equal(sa.emptyBefore, 0);
  assert.deepEqual(sa.lineup.filter((x) => !x.player).map((x) => x.slot), ["C"]);
  assert.deepEqual(sa.positions.find((p) => p.group === "C"), { group: "C", needed: 1, before: 1, after: 0 });
});

test("the lineup fills as many slots as it can, best players first", () => {
  // The F-C is the best player; he must take C so the F can start too.
  const ps = [player(1, "F-C", 3), player(2, "F", 2), player(3, "G", 1), player(4, "G", 0.5)];
  const lu = bestLineup(ps, [{ slot: "G", count: 1 }, { slot: "F", count: 1 }, { slot: "C", count: 1 }], (p) => p.season!.value);
  assert.deepEqual(lu.map((x) => [x.slot, x.player?.id]), [["G", 3], ["F", 2], ["C", 1]]);
});

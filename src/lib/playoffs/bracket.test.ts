// Run: npx tsx --test src/lib/playoffs/bracket.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MatchupScore } from "../types";
import {
  advancing, bracketLabel, bracketOrder, bracketRounds, bracketSeeds, firstRound, nextRound, outcome, roundWeek,
  standingsOrder, type Pairing, type Played, type Seeded,
} from "./bracket";

const seeds = (...ns: number[]): Seeded[] => ns.map((n) => ({ teamId: 100 + n, seed: n }));
const pairs = (ps: Pairing[]) => ps.map((p) => [p.a.seed, p.b?.seed ?? null]);
const score = (wins: number, losses: number, ties = 9 - wins - losses): MatchupScore => ({ wins, losses, ties });
/** Plays a round: `scores[i]` is the score for slot i's `a`. */
const play = (ps: Pairing[], scores: MatchupScore[]): Played[] => ps.map((p, i) => ({ ...p, score: scores[i] }));

test("seeds follow the standings: win %, then category wins, then name", () => {
  const teams = [
    { id: 1, name: "Zebras", record: score(5, 4, 0) },
    { id: 2, name: "Ants", record: score(5, 4, 0) },
    { id: 3, name: "Bees", record: score(6, 3, 0) },
    // Same .556 as 5–4–0 (4 + 2/2 over 9) but fewer wins.
    { id: 4, name: "Cats", record: score(4, 3, 2) },
    { id: 5, name: "Dogs", record: score(0, 0, 0) },
  ];
  assert.deepEqual(standingsOrder(teams).map((t) => t.name), ["Bees", "Ants", "Zebras", "Cats", "Dogs"]);
});

test("bracket sizes and positions", () => {
  assert.deepEqual([1, 2, 3, 4, 6, 8, 9].map(bracketRounds), [0, 1, 2, 2, 3, 3, 4]);
  assert.deepEqual(bracketOrder(8), [1, 8, 5, 4, 3, 6, 7, 2]);
  assert.deepEqual(bracketSeeds(12, 8, 4), { playoffs: [1, 2, 3, 4, 5, 6, 7, 8], toiletBowl: [9, 10, 11, 12] });
  // 6 + 4 of 12 leaves seeds 7 and 8 out of both.
  assert.deepEqual(bracketSeeds(12, 6, 4).toiletBowl, [9, 10, 11, 12]);
  // Never overlaps the playoffs.
  assert.deepEqual(bracketSeeds(10, 8, 4).toiletBowl, [9, 10]);
});

test("8-team playoffs: 1v8, 4v5, 3v6, 2v7", () => {
  assert.deepEqual(pairs(firstRound("playoffs", seeds(1, 2, 3, 4, 5, 6, 7, 8))), [[1, 8], [4, 5], [3, 6], [2, 7]]);
});

test("6-team playoffs give the top two seeds byes", () => {
  assert.deepEqual(pairs(firstRound("playoffs", seeds(1, 2, 3, 4, 5, 6))), [[1, null], [4, 5], [3, 6], [2, null]]);
});

test("4-team toilet bowl: 9v12 and 10v11", () => {
  assert.deepEqual(pairs(firstRound("toilet_bowl", seeds(9, 10, 11, 12))), [[9, 12], [10, 11]]);
});

test("a 3-team toilet bowl gives the bye to the worst team", () => {
  assert.deepEqual(pairs(firstRound("toilet_bowl", seeds(10, 11, 12))), [[12, null], [10, 11]]);
});

test("playoffs: winners advance to the final", () => {
  const qf = firstRound("playoffs", seeds(1, 2, 3, 4, 5, 6, 7, 8));
  // 8 upsets 1; 4 beats 5; 6 upsets 3; 2 beats 7.
  const sf = nextRound("playoffs", play(qf, [score(3, 6), score(5, 4), score(2, 7), score(6, 2)]));
  assert.deepEqual(pairs(sf), [[8, 4], [6, 2]]);
  const f = nextRound("playoffs", play(sf, [score(5, 3), score(1, 8)]));
  assert.deepEqual(pairs(f), [[8, 2]]);
  assert.equal(outcome(play(f, [score(4, 5)])[0]).winner.seed, 2);
});

test("toilet bowl: losers advance, and the final's loser is last place", () => {
  const r1 = firstRound("toilet_bowl", seeds(9, 10, 11, 12));
  // 9 loses to 12; 10 beats 11.
  const final = nextRound("toilet_bowl", play(r1, [score(2, 7), score(6, 3)]));
  assert.deepEqual(pairs(final), [[9, 11]]);
  // 9 wins the final, so 11 finishes last.
  assert.equal(advancing("toilet_bowl", play(final, [score(5, 4)])[0]).seed, 11);
});

test("a tie goes to the better seed in both brackets", () => {
  const tie = { a: seeds(4)[0], b: seeds(5)[0], score: score(4, 4, 1) };
  assert.equal(outcome(tie).winner.seed, 4);
  assert.equal(advancing("playoffs", tie).seed, 4);
  // In the toilet bowl the worse seed advances toward last place.
  assert.equal(advancing("toilet_bowl", { a: seeds(9)[0], b: seeds(12)[0], score: score(0, 0, 9) }).seed, 12);
  // Order of the sides doesn't matter: a later round can have the worse seed as `a`.
  assert.equal(outcome({ a: seeds(8)[0], b: seeds(1)[0], score: score(3, 3, 3) }).winner.seed, 1);
});

test("byes advance in both brackets", () => {
  const bye = { a: seeds(1)[0], b: null, score: score(0, 0, 0) };
  assert.equal(advancing("playoffs", bye).seed, 1);
  assert.equal(advancing("toilet_bowl", { ...bye, a: seeds(12)[0] }).seed, 12);
  const r1 = firstRound("playoffs", seeds(1, 2, 3, 4, 5, 6));
  const sf = nextRound("playoffs", play(r1, [score(0, 0), score(2, 7), score(6, 3), score(0, 0)]));
  assert.deepEqual(pairs(sf), [[1, 5], [3, 2]]);
});

test("weeks and labels: the toilet bowl ends with the final", () => {
  assert.deepEqual([1, 2, 3].map((r) => roundWeek("playoffs", r, 22, 3, 2)), [22, 23, 24]);
  assert.deepEqual([1, 2].map((r) => roundWeek("toilet_bowl", r, 22, 3, 2)), [23, 24]);
  assert.deepEqual([1, 2, 3].map((r) => bracketLabel("playoffs", r, 3)), [
    "Playoffs · Quarterfinal", "Playoffs · Semifinal", "Playoffs · Final",
  ]);
  assert.deepEqual([1, 2].map((r) => bracketLabel("toilet_bowl", r, 2)), ["Toilet bowl · Round 1", "Toilet bowl · Final"]);
});

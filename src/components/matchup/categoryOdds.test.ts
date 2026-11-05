// Run: npx tsx --test src/components/matchup/categoryOdds.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CategoryLine } from "@/lib/types";
import { categoryOdds, fmtChance, matchupOdds } from "./categoryOdds";

function line(o: Partial<CategoryLine> = {}): CategoryLine {
  const l = { fgm: 0, fga: 0, ftm: 0, fta: 0, fg3m: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, ...o };
  return { ...l, fgPct: l.fga ? l.fgm / l.fga : null, ftPct: l.fta ? l.ftm / l.fta : null };
}

test("nothing left to play: decided", () => {
  const a = line({ pts: 500, tov: 30 });
  const b = line({ pts: 499, tov: 30 });
  assert.equal(categoryOdds("pts", a, a, b, b).tier, "won");
  assert.equal(categoryOdds("pts", b, b, a, a).tier, "lost");
  assert.equal(categoryOdds("tov", a, a, b, b).tier, "tied");
});

test("the same lead is safe late and a toss-up early", () => {
  const now = line({ pts: 540 });
  const opp = line({ pts: 500 });
  // Last night: about 20 points each to come.
  const late = categoryOdds("pts", now, line({ pts: 560 }), opp, line({ pts: 520 }));
  // A 20-point lead with about 60 points each to come leans, without being safe.
  const lateSmall = categoryOdds("pts", line({ pts: 480 }), line({ pts: 540 }), line({ pts: 460 }), line({ pts: 520 }));
  // Start of the week: about 600 points each to come.
  const early = categoryOdds("pts", line(), line({ pts: 620 }), line(), line({ pts: 600 }));
  assert.equal(late.tier, "safe");
  assert.equal(lateSmall.tier, "ahead");
  assert.equal(early.tier, "tossup");
  assert.ok(early.chance > 0.5);
});

test("fewer turnovers is ahead", () => {
  const o = categoryOdds("tov", line({ tov: 10 }), line({ tov: 20 }), line({ tov: 25 }), line({ tov: 35 }));
  assert.ok(o.chance > 0.9);
});

test("a level projection is a coin flip", () => {
  const o = categoryOdds("stl", line({ stl: 5 }), line({ stl: 15 }), line({ stl: 7 }), line({ stl: 15 }));
  assert.ok(Math.abs(o.chance - 0.5) < 1e-6);
  assert.equal(o.tier, "tossup");
});

test("percentages tighten as attempts run out", () => {
  // .500 vs .470 on the projection.
  const early = categoryOdds("fgPct", line(), line({ fgm: 200, fga: 400 }), line(), line({ fgm: 188, fga: 400 }));
  const late = categoryOdds("fgPct", line({ fgm: 190, fga: 380 }), line({ fgm: 200, fga: 400 }), line({ fgm: 179, fga: 380 }), line({ fgm: 188, fga: 400 }));
  assert.ok(late.chance > early.chance);
  assert.equal(late.tier, "safe");
  assert.ok(early.chance > 0.5 && early.chance < 0.9);
});

test("no attempts at all loses the percentage", () => {
  const o = categoryOdds("ftPct", line(), line(), line({ ftm: 1, fta: 2 }), line({ ftm: 1, fta: 2 }));
  assert.equal(o.tier, "lost");
});

test("matchupOdds covers every category; fmtChance never shows certainty while live", () => {
  const odds = matchupOdds(line(), line({ pts: 1000 }), line(), line({ pts: 10 }));
  assert.equal(Object.keys(odds).length, 9);
  assert.equal(fmtChance(odds.pts), ">99%");
  assert.equal(fmtChance({ chance: 0.004, tier: "gone" }), "<1%");
  assert.equal(fmtChance({ chance: 0.62, tier: "ahead" }), "62%");
  assert.equal(fmtChance({ chance: 1, tier: "won" }), "Won");
});

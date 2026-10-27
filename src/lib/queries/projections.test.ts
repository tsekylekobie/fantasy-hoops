// Run: npx tsx --test src/lib/queries/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlayerInjury } from "../types";
import { PROJECTION_MIN_GP, perGameBasis, projectStarts, roundLine, sitsOut } from "./projections";
import type { SeasonTotals } from "./value";

function totals(gp: number, pts: number, over: Partial<SeasonTotals> = {}): SeasonTotals {
  return {
    playerId: 1, gp, min: gp * 30, fgm: 0, fga: 0, ftm: 0, fta: 0, fg3m: 0,
    pts, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, ...over,
  };
}

const out = (returnDate: string | null): PlayerInjury => ({ status: "Out", returnDate, injury: null, note: null });

test("the last 30 days with enough games, else the season", () => {
  assert.equal(perGameBasis(totals(PROJECTION_MIN_GP, 150), totals(20, 400))?.pts, 30);
  assert.equal(perGameBasis(totals(PROJECTION_MIN_GP - 1, 150), totals(20, 400))?.pts, 20);
  assert.equal(perGameBasis(undefined, totals(20, 400))?.pts, 20);
  assert.equal(perGameBasis(undefined, undefined), null);
});

test("Out sits until the return date; other statuses play", () => {
  assert.equal(sitsOut(out(null), "2026-11-01"), true);
  assert.equal(sitsOut(out("2026-11-03"), "2026-11-02"), true);
  assert.equal(sitsOut(out("2026-11-03"), "2026-11-03"), false);
  assert.equal(sitsOut({ ...out(null), status: "Questionable" }, "2026-11-01"), false);
  assert.equal(sitsOut(undefined, "2026-11-01"), false);
});

test("each start adds one game of the player's basis, per team and player", () => {
  const bases = new Map([[7, perGameBasis(undefined, totals(4, 100, { fgm: 18, fga: 40 }))!]]);
  const starts = [
    { team_id: 1, player_id: 7 },
    { team_id: 1, player_id: 7 },
    { team_id: 1, player_id: 8 }, // no games this season: adds nothing
  ];
  const rows = projectStarts(starts, bases);
  assert.deepEqual([...rows.keys()], ["1:7"]);
  const r = rows.get("1:7")!;
  assert.equal(r.gp, 2);
  assert.equal(r.pts, 50);
  assert.equal(r.fgm, 9);
  assert.equal(r.fga, 20);
});

test("rounding keeps makes within attempts", () => {
  const r = roundLine({ gp: 3, fgm: 13.5, fga: 27.4, ftm: 0.4, fta: 0.6, fg3m: 2.5, pts: 37.49, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0 });
  assert.deepEqual([r.fgm, r.fga, r.ftm, r.fta, r.fg3m, r.pts, r.gp], [14, 27, 0, 1, 3, 37, 3]);
});

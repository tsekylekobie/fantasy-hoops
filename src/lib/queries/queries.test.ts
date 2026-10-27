// Run: npx tsx --test src/lib/queries/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequest, nameMatches, normalizeName, parsePlayersQuery, positionMatches } from "./params";
import { categoryLine } from "./players";
import { DEFAULT_WEIGHTS } from "../types";
import { EQUAL_WEIGHTS, POOL_SIZE, selectPool, valuePlayers, type SeasonTotals } from "./value";

function player(id: number, over: Partial<SeasonTotals> = {}): SeasonTotals {
  return {
    playerId: id, gp: 10, min: 300, fgm: 50, fga: 100, ftm: 20, fta: 25, fg3m: 15,
    pts: 135, reb: 50, ast: 30, stl: 10, blk: 5, tov: 20, ...over,
  };
}

test("identical players all get value 0", () => {
  const v = valuePlayers([player(1), player(2), player(3)]);
  for (const id of [1, 2, 3]) assert.equal(v.get(id)!.value, 0);
});

test("better counting stats raise value; more turnovers lower it", () => {
  const v = valuePlayers([player(1), player(2, { pts: 300 }), player(3, { tov: 60 })]);
  assert.equal(v.get(2)!.rank, 1);
  assert.equal(v.get(3)!.rank, 3);
  assert.ok(v.get(3)!.value < 0);
});

test("FG% impact weights volume: 50% on 200 FGA beats 60% on 10 FGA when league is 45%", () => {
  const base = Array.from({ length: 10 }, (_, i) => player(10 + i, { fgm: 45, fga: 100 }));
  const volume = player(1, { fgm: 100, fga: 200 });
  const lowVolume = player(2, { fgm: 6, fga: 10 });
  const v = valuePlayers([...base, volume, lowVolume]);
  assert.ok(v.get(1)!.value > v.get(2)!.value);
});

test("value is per game: doubling every total and GP leaves value unchanged", () => {
  const a = valuePlayers([player(1), player(2, { pts: 200 }), player(3, { reb: 90 })]);
  const dbl = (p: SeasonTotals) =>
    Object.fromEntries(Object.entries(p).map(([k, x]) => [k, k === "playerId" ? x : x * 2])) as unknown as SeasonTotals;
  const b = valuePlayers([player(1), dbl(player(2, { pts: 200 })), player(3, { reb: 90 })]);
  assert.ok(Math.abs(a.get(2)!.value - b.get(2)!.value) < 1e-9);
});

test("pool requires 25% of max GP and takes the top POOL_SIZE by value, not minutes", () => {
  const many = Array.from({ length: 200 }, (_, i) => player(i + 1, { pts: 100 + 2 * i }));
  const fewGames = player(999, { gp: 2, pts: 80 }); // 40 ppg but 2 < ceil(10 * 0.25) = 3
  const heavyMinutes = player(998, { min: 400, pts: 50 }); // most minutes per game, least scoring
  const pool = selectPool([...many, fewGames, heavyMinutes]);
  assert.equal(pool.length, POOL_SIZE);
  assert.ok(!pool.some((p) => p.playerId === 999));
  assert.ok(!pool.some((p) => p.playerId === 998));
  assert.equal(pool[0].playerId, 200);
  assert.equal(Math.min(...pool.map((p) => p.playerId)), 200 - POOL_SIZE + 1);
  // Out-of-pool players still get a value and rank.
  const v = valuePlayers([...many, fewGames, heavyMinutes]);
  assert.equal(v.size, 202);
  assert.ok(Number.isFinite(v.get(999)!.value));
});

test("players with zero GP are ignored; tiny early-season samples don't produce NaN", () => {
  const v = valuePlayers([player(1, { gp: 1, fga: 0, fgm: 0, fta: 0, ftm: 0 }), player(2, { gp: 0 })]);
  assert.equal(v.size, 1);
  assert.equal(v.get(1)!.value, 0);
});

test("punt weights: 0 ignores a category, other weights scale it", () => {
  // The scorer also rebounds a little, so the two aren't tied on value.
  const players = [player(1, { pts: 300, reb: 60 }), player(2, { reb: 90 }), player(3, { tov: 60 })];
  const plain = valuePlayers(players);
  const punted = valuePlayers(players, { ...EQUAL_WEIGHTS, pts: 0 });
  // Punting points drops the scorer below the rebounder.
  assert.ok(plain.get(1)!.rank < plain.get(2)!.rank);
  assert.ok(punted.get(2)!.rank < punted.get(1)!.rank);
  // Value is the weighted average: turnovers at 0.25 count a quarter, over 8.25 weights instead of 9.
  const quarter = valuePlayers([player(1), player(3, { tov: 60 })], { ...EQUAL_WEIGHTS, tov: 0.25 });
  const full = valuePlayers([player(1), player(3, { tov: 60 })]);
  assert.ok(Math.abs(quarter.get(3)!.value * 8.25 - (full.get(3)!.value * 9) / 4) < 1e-9);
});

test("value is the weighted average of the z-scores: scaling every weight changes nothing", () => {
  const players = [player(1, { pts: 300 }), player(2, { reb: 90 }), player(3, { tov: 60 }), player(4)];
  const ones = valuePlayers(players);
  const twos = valuePlayers(players, Object.fromEntries(Object.keys(EQUAL_WEIGHTS).map((c) => [c, 2])) as typeof EQUAL_WEIGHTS);
  for (const id of [1, 2, 3, 4]) assert.ok(Math.abs(ones.get(id)!.value - twos.get(id)!.value) < 1e-9);
  const none = valuePlayers(players, Object.fromEntries(Object.keys(EQUAL_WEIGHTS).map((c) => [c, 0])) as typeof EQUAL_WEIGHTS);
  for (const id of [1, 2, 3, 4]) assert.equal(none.get(id)!.value, 0);
});

test("parsePlayersQuery: weights in CATEGORIES order", () => {
  const q = parsePlayersQuery(new URLSearchParams("weights=0,1,1,1.5,1,1,1,0.333,0.25"));
  assert.deepEqual(q.weights, { fgPct: 0, ftPct: 1, fg3m: 1, pts: 1.5, reb: 1, ast: 1, stl: 1, blk: 0.33, tov: 0.25 });
});

test("categoryLine: percentages from totals, null with no attempts, avg divides by GP", () => {
  const row = { player_id: 1, ...player(1, { fta: 0, ftm: 0 }), tov: 21 };
  const avg = categoryLine(row, "avg");
  assert.equal(avg.fgPct, 0.5);
  assert.equal(avg.ftPct, null);
  assert.equal(avg.pts, 13.5);
  assert.equal(avg.tov, 2.1);
  assert.equal(avg.min, 30);
  const total = categoryLine(row, "total");
  assert.equal(total.pts, 135);
  assert.equal(total.fgPct, 0.5);
});

test("name search is case- and accent-insensitive", () => {
  assert.equal(normalizeName("  Luka  DONČIĆ "), "luka doncic");
  assert.ok(nameMatches("doncic", "Luka", "Dončić"));
  assert.ok(nameMatches("LUK don", "Luka", "Dončić"));
  assert.ok(nameMatches("sengun", "Alperen", "Şengün"));
  assert.ok(nameMatches("gilgeous alex", "Shai", "Gilgeous-Alexander"));
  assert.ok(!nameMatches("lebron", "Luka", "Dončić"));
  assert.ok(nameMatches("", "Luka", "Dončić"));
});

test("position filter matches any letter in a combined position", () => {
  assert.ok(positionMatches("G", "G-F"));
  assert.ok(positionMatches("F", "G-F"));
  assert.ok(!positionMatches("C", "G-F"));
  assert.ok(!positionMatches("G", null));
  assert.ok(positionMatches("all", null));
});

test("parsePlayersQuery: defaults and validation", () => {
  const d = parsePlayersQuery(new URLSearchParams(""));
  assert.deepEqual(d, { season: 2026, range: "season", sort: "value", dir: "desc", mode: "avg", scope: "all", q: "", pos: "all", plays: [], waivers: "any", team: null, nba: null, weights: DEFAULT_WEIGHTS, page: 1, perPage: 50 });
  const p = parsePlayersQuery(new URLSearchParams("season=2025&range=last14&sort=tov&mode=total&scope=fa&pos=g&page=3&perPage=100&q=%20jo%20&plays=tomorrow&waivers=on&team=7&nba=bos"));
  assert.deepEqual(p, { season: 2025, range: "last14", sort: "tov", dir: "asc", mode: "total", scope: "fa", q: "jo", pos: "G", plays: ["tomorrow"], waivers: "on", team: 7, nba: "BOS", weights: DEFAULT_WEIGHTS, page: 3, perPage: 100 });
  for (const bad of ["mode=x", "range=last7", "sort=rank", "sort=pts&dir=up", "scope=mine", "pos=PG", "page=0", "page=-1", "perPage=101", "season=abc", "season=1800", "page=1.5", "team=0", "team=x", "nba=B", "nba=LA-L",
    "weights=1,1,1", "weights=1,1,1,1,1,1,1,1,2.5", "weights=1,1,1,1,1,1,1,1,-1", "weights=1,1,1,1,1,1,1,1,x"]) {
    assert.throws(() => parsePlayersQuery(new URLSearchParams(bad)), BadRequest, bad);
  }
  assert.equal(parsePlayersQuery(new URLSearchParams("range=last30")).range, "last30");
});

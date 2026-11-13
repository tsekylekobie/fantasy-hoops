// Run: npx tsx --test src/lib/queries/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequest, nameMatches, normalizeName, parsePlayersQuery, positionMatches } from "./params";
import { categoryLine } from "./players";
import { DEFAULT_WEIGHTS } from "../types";
import { DURANT_H2H_WEIGHTS, EQUAL_WEIGHTS, POOL_SIZE, durantValue, selectPool, valuePlayers, type SeasonTotals } from "./value";

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

test("better counting stats raise value; turnovers don't count (DURANT H2H)", () => {
  const v = valuePlayers([player(1), player(2, { pts: 300 }), player(3, { tov: 60 }), player(4, { pts: 90, reb: 30 })]);
  assert.equal(v.get(2)!.rank, 1);
  assert.equal(v.get(4)!.rank, 4);
  assert.ok(v.get(4)!.value < 0);
  assert.equal(v.get(3)!.value, v.get(1)!.value);
});

const scores = (over: Partial<Record<keyof typeof EQUAL_WEIGHTS, number>>) => ({ ...Object.fromEntries(Object.keys(EQUAL_WEIGHTS).map((c) => [c, 0])), ...over }) as typeof EQUAL_WEIGHTS;
const H2H_SUM = 1 + 0.94 + 0.75 + 5 * 0.6;

test("durantValue: DURANT H2H weights, TO excluded, Minus 1 drops the worst weighted contribution", () => {
  assert.equal(DURANT_H2H_WEIGHTS.tov, 0);
  // Two weak categories: the worse weighted one (FT% -2 * 0.6 = -1.2, vs AST -1 * 0.75) is dropped.
  const a = durantValue(scores({ pts: 1, reb: 1, ast: -1, ftPct: -2, tov: -5 }), EQUAL_WEIGHTS);
  assert.equal(a.dropped, "ftPct");
  assert.ok(Math.abs(a.value - (1 + 0.94 - 0.75) / H2H_SUM) < 1e-12);
  // All positive: the smallest contribution is still dropped.
  const b = durantValue(scores({ pts: 1, reb: 1, ast: 1, fgPct: 1, ftPct: 1, fg3m: 1, stl: 1, blk: 1 }), EQUAL_WEIGHTS);
  assert.ok(Math.abs(b.value - (H2H_SUM - 0.6) / H2H_SUM) < 1e-12);
  // Punting FT% (weight 0) leaves it out, so Minus 1 drops AST instead.
  const c = durantValue(scores({ pts: 1, reb: 1, ast: -1, ftPct: -2 }), { ...EQUAL_WEIGHTS, ftPct: 0 });
  assert.equal(c.dropped, "ast");
  assert.ok(Math.abs(c.value - (1 + 0.94) / (H2H_SUM - 0.6)) < 1e-12);
  // Any weight above 0 counts fully (old saved slider weights): only punts matter.
  assert.deepEqual(durantValue(scores({ pts: 1, reb: -1 }), { ...EQUAL_WEIGHTS, pts: 0.3, reb: 2 }), durantValue(scores({ pts: 1, reb: -1 }), EQUAL_WEIGHTS));
  // A turnover weight never brings TO back.
  assert.equal(durantValue(scores({ tov: 3 }), { ...EQUAL_WEIGHTS, tov: 2 }).value, 0);
});

test("FG%/FT% impact: z-scores per game, season totals = makes - pool % * attempts", () => {
  const base = Array.from({ length: 10 }, (_, i) => player(10 + i, { fgm: 45, fga: 100 }));
  const volume = player(1, { fgm: 100, fga: 200 });
  const lowVolume = player(2, { fgm: 6, fga: 10 });
  const longer = player(3, { gp: 20, min: 600, fgm: 200, fga: 400 }); // volume's per-game line over twice the games
  const v = valuePlayers([...base, volume, lowVolume, longer]);
  const pct = (450 + 100 + 6 + 200) / (1000 + 200 + 10 + 400);
  assert.ok(Math.abs(v.get(1)!.impact.fgPct - (100 - pct * 200)) < 1e-9);
  assert.ok(v.get(1)!.z.fgPct > v.get(2)!.z.fgPct);
  assert.ok(Math.abs(v.get(3)!.z.fgPct - v.get(1)!.z.fgPct) < 1e-9);
  assert.ok(v.get(3)!.impact.fgPct > v.get(1)!.impact.fgPct);
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
  const many = Array.from({ length: 200 }, (_, i) => player(i + 1, { pts: 100 + 2 * i, reb: 40 + i / 2 }));
  const fewGames = player(999, { gp: 2, pts: 80 }); // 40 ppg but 2 < ceil(10 * 0.25) = 3
  const heavyMinutes = player(998, { min: 400, pts: 50, reb: 30 }); // most minutes per game, least scoring and rebounding
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
});

test("value is a weighted average: scaling every punt weight changes nothing", () => {
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
  assert.deepEqual(d, { season: 2026, range: "season", dates: null, sort: "value", dir: "desc", mode: "avg", scope: "all", q: "", pos: "all", plays: [], waivers: "any", hideInjured: false, team: null, nba: null, weights: DEFAULT_WEIGHTS, page: 1, perPage: 50 });
  const p = parsePlayersQuery(new URLSearchParams("season=2025&range=last14&sort=tov&mode=total&scope=fa&pos=g&page=3&perPage=100&q=%20jo%20&plays=tomorrow&waivers=on&team=7&nba=bos"));
  assert.deepEqual(p, { season: 2025, range: "last14", dates: null, sort: "tov", dir: "asc", mode: "total", scope: "fa", q: "jo", pos: "G", plays: ["tomorrow"], waivers: "on", hideInjured: false, team: 7, nba: "BOS", weights: DEFAULT_WEIGHTS, page: 3, perPage: 100 });
  assert.equal(parsePlayersQuery(new URLSearchParams("scope=watch")).scope, "watch");
  assert.equal(parsePlayersQuery(new URLSearchParams("injured=hide")).hideInjured, true);
  for (const bad of ["mode=x", "range=last7", "sort=rank", "sort=pts&dir=up", "scope=mine", "pos=PG", "page=0", "page=-1", "perPage=101", "season=abc", "season=1800", "page=1.5", "team=0", "team=x", "nba=B", "nba=LA-L",
    "weights=1,1,1", "weights=1,1,1,1,1,1,1,1,2.5", "weights=1,1,1,1,1,1,1,1,-1", "weights=1,1,1,1,1,1,1,1,x"]) {
    assert.throws(() => parsePlayersQuery(new URLSearchParams(bad)), BadRequest, bad);
  }
  assert.equal(parsePlayersQuery(new URLSearchParams("range=last30")).range, "last30");
});

test("parsePlayersQuery: custom range needs real from <= to dates", () => {
  const c = parsePlayersQuery(new URLSearchParams("range=custom&from=2026-11-01&to=2026-11-05"));
  assert.equal(c.range, "custom");
  assert.deepEqual(c.dates, { from: "2026-11-01", to: "2026-11-05" });
  assert.deepEqual(parsePlayersQuery(new URLSearchParams("range=custom&from=2026-11-05&to=2026-11-05")).dates, { from: "2026-11-05", to: "2026-11-05" });
  // Dates are ignored by the presets.
  assert.equal(parsePlayersQuery(new URLSearchParams("range=last14&from=2026-11-01&to=2026-11-05")).dates, null);
  for (const bad of ["range=custom", "range=custom&from=2026-11-01", "range=custom&to=2026-11-01", "range=custom&from=2026-11-06&to=2026-11-05",
    "range=custom&from=2026-02-30&to=2026-03-05", "range=custom&from=11/01/2026&to=2026-11-05"]) {
    assert.throws(() => parsePlayersQuery(new URLSearchParams(bad)), BadRequest, bad);
  }
});

test("tiers place each category against the pool: best is top 10%, worst bottom 10%, TO fewer is better", () => {
  const players = Array.from({ length: 20 }, (_, i) => player(i + 1, { pts: 100 + i * 10, tov: 10 + i }));
  const v = valuePlayers(players);
  assert.equal(v.get(20)!.tiers.pts, "top10");
  assert.equal(v.get(1)!.tiers.pts, "bottom10");
  assert.equal(v.get(1)!.tiers.tov, "top10");
  assert.equal(v.get(20)!.tiers.tov, "bottom10");
  // Everyone has the same rebounds: the middle of the tie.
  assert.equal(v.get(5)!.tiers.reb, "mid");
});

test("no FG%/FT% tier without attempts", () => {
  const v = valuePlayers([player(1), player(2), player(3, { fga: 0, fgm: 0, fta: 0, ftm: 0 })]);
  assert.equal(v.get(3)!.tiers.fgPct, undefined);
  assert.equal(v.get(3)!.tiers.ftPct, undefined);
  assert.ok(v.get(1)!.tiers.fgPct);
});

test("totals: the same per-game line over fewer games ranks lower, Value and rank included", () => {
  const base = Array.from({ length: 19 }, (_, i) => player(i + 10, { pts: 100 + i * 5, reb: 40 + i }));
  const star = player(1, { pts: 300, reb: 59 }); // 30 a game over 10 games: best per game and in totals
  const short = player(2, { gp: 2, min: 60, fgm: 10, fga: 20, ftm: 4, fta: 5, fg3m: 3, pts: 60, reb: 10, ast: 6, stl: 2, blk: 1, tov: 4 });
  const v = valuePlayers([...base, star, short]);
  assert.equal(v.get(1)!.totalTiers.pts, "top10");
  assert.equal(v.get(2)!.tiers.pts, "top10"); // 30 a game
  assert.equal(v.get(2)!.totalTiers.pts, "bottom10"); // 60 in total
  assert.equal(v.get(2)!.totalTiers.tov, "top10"); // fewest turnovers in total
  // Per game he's the best (he matches the star's 30 a game and is otherwise average); in totals he's far behind.
  assert.ok(v.get(2)!.value > v.get(10)!.value);
  assert.ok(v.get(2)!.totalValue < v.get(10)!.totalValue);
  assert.ok(v.get(2)!.totalRank > v.get(10)!.totalRank);
  assert.equal(v.get(1)!.totalRank, 1);
  assert.equal(v.get(2)!.totalTiers.value, "bottom10");
});

test("totals: identical totals value 0; ranks are a permutation", () => {
  const same = valuePlayers([player(1), player(2), player(3)]);
  for (const id of [1, 2, 3]) assert.equal(same.get(id)!.totalValue, 0);
  const v = valuePlayers(Array.from({ length: 30 }, (_, i) => player(i + 1, { gp: 5 + i, pts: 100 + i * 7 })));
  assert.deepEqual([...v.values()].map((x) => x.totalRank).sort((a, b) => a - b), Array.from({ length: 30 }, (_, i) => i + 1));
});

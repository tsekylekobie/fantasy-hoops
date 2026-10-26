// Run: npx tsx --test src/lib/lineup/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GameLimits, LineupSlot } from "../types";
import { countStarts, gameLimitUsage, parseGameLimits, type Start } from "./gameLimits";

let nextId = 1;
const start = (slot: LineupSlot, date: string, time: string | null = "23:00", gameId = nextId++): Start =>
  ({ slot, date, tipoff: time === null ? null : `${date}T${time}:00Z`, gameId });

test("no limits: every start counts", () => {
  const starts = [start("C", "2026-10-26"), start("PG", "2026-10-27")];
  assert.deepEqual(countStarts(starts, null), ["counted", "counted"]);
});

test("the total stops later starts, counted in tip-off order", () => {
  const limits: GameLimits = { total: 2, slots: {} };
  // Given out of order: the Wednesday game is the third to tip off.
  const starts = [start("PG", "2026-10-28"), start("C", "2026-10-26"), start("SG", "2026-10-27")];
  assert.deepEqual(countStarts(starts, limits), ["total", "counted", "counted"]);
});

test("same tip-off: earlier time first, then game id; unknown times last", () => {
  const limits: GameLimits = { total: 1, slots: {} };
  assert.deepEqual(
    countStarts([start("PG", "2026-10-26", "23:30", 5), start("C", "2026-10-26", "23:00", 9)], limits),
    ["total", "counted"],
  );
  assert.deepEqual(
    countStarts([start("PG", "2026-10-26", "23:00", 9), start("C", "2026-10-26", "23:00", 5)], limits),
    ["total", "counted"],
  );
  assert.deepEqual(
    countStarts([start("PG", "2026-10-26", null, 1), start("C", "2026-10-26", "23:00", 9)], limits),
    ["total", "counted"],
  );
});

test("a slot's spots share its cap; other slots keep counting", () => {
  const limits: GameLimits = { total: 40, slots: { C: 2 } };
  const starts = [
    start("C", "2026-10-26"), start("C", "2026-10-26", "23:30"), start("C", "2026-10-27"), start("PG", "2026-10-27"),
  ];
  assert.deepEqual(countStarts(starts, limits), ["counted", "counted", "slot", "counted"]);
});

test("a start a limit stops uses up nothing", () => {
  // C is capped at 1; the second C start doesn't eat into the total of 2.
  const limits: GameLimits = { total: 2, slots: { C: 1 } };
  const starts = [start("C", "2026-10-26"), start("C", "2026-10-27"), start("PG", "2026-10-28"), start("SG", "2026-10-29")];
  assert.deepEqual(countStarts(starts, limits), ["counted", "slot", "counted", "total"]);
});

test("a cap of 0 means the slot never counts", () => {
  assert.deepEqual(countStarts([start("UTIL", "2026-10-26")], { total: 5, slots: { UTIL: 0 } }), ["slot"]);
});

test("usage: used from played games, planned and blocked days from upcoming ones", () => {
  const limits: GameLimits = { total: 4, slots: { C: 2, PG: 3 } };
  const played = [start("C", "2026-10-26"), start("PG", "2026-10-26"), start("C", "2026-10-27")];
  const upcoming = [start("C", "2026-10-29"), start("PG", "2026-10-29"), start("SG", "2026-10-30"), start("C", "2026-10-30")];
  assert.deepEqual(gameLimitUsage(played, upcoming, limits), {
    total: { limit: 4, used: 3, planned: 4, blockedDays: ["2026-10-30"] },
    slots: [
      { slot: "PG", limit: 3, used: 1, planned: 2, blockedDays: [] },
      { slot: "C", limit: 2, used: 2, planned: 2, blockedDays: ["2026-10-29", "2026-10-30"] },
    ],
  });
  assert.equal(gameLimitUsage(played, upcoming, null), null);
});

test("parseGameLimits: off, valid, slot order and bad input", () => {
  assert.deepEqual(parseGameLimits(null), { limits: null });
  assert.deepEqual(parseGameLimits({ total: 40, slots: { UTIL: null, C: 8, PG: 5 } }), {
    limits: { total: 40, slots: { PG: 5, C: 8 } },
  });
  assert.deepEqual(parseGameLimits({ total: 40 }), { limits: { total: 40, slots: {} } });
  for (const bad of [{ total: 0 }, { total: 201 }, { total: 4.5 }, { total: 40, slots: { BN: 3 } },
    { total: 40, slots: { C: -1 } }, { total: 40, slots: [] }, "40"]) {
    assert.ok("error" in parseGameLimits(bad), JSON.stringify(bad));
  }
});

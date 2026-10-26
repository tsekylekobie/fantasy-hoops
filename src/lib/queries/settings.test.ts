// Run: npx tsx --test src/lib/queries/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LeagueSettings } from "../types";
import { parseSettings } from "./settings";

const valid: LeagueSettings = {
  waiverType: "continual_rolling", waiverTime: "03:00", timeZone: "America/New_York",
  waiverDaysOfWeek: [1, 2, 3, 4, 5, 6, 7], waiverDays: 2, waiversAfterGameStart: false,
  ilSlots: 2, ilStatuses: ["Out"], ilMinDays: 0, ilPlusSlots: 0, ilPlusStatuses: [], ilPlusMinDays: 0,
  tradeReview: "league_vote", tradeReviewDays: 2, tradeVetoVotes: 4, tradeDeadline: null,
  maxAddsPerWeek: 4, maxAddsPerSeason: null,
};

const error = (over: Partial<Record<keyof LeagueSettings, unknown>>) => {
  const r = parseSettings({ ...valid, ...over }, 12);
  return "error" in r ? r.error : null;
};

test("the seeded settings are valid", () => {
  assert.deepEqual(parseSettings(valid, 12), { settings: valid });
});

test("weekdays and statuses come back sorted and deduplicated", () => {
  const r = parseSettings({ ...valid, waiverDaysOfWeek: [5, 2, 5], ilStatuses: ["Day-To-Day", "Out"] }, 12);
  assert.ok("settings" in r);
  assert.deepEqual(r.settings.waiverDaysOfWeek, [2, 5]);
  assert.deepEqual(r.settings.ilStatuses, ["Out", "Day-To-Day"]);
});

test("waivers need at least one real weekday", () => {
  assert.ok(error({ waiverDaysOfWeek: [] }));
  assert.ok(error({ waiverDaysOfWeek: [0] }));
  assert.ok(error({ waiverDaysOfWeek: [8] }));
  assert.ok(error({ waiverDaysOfWeek: "1,2" }));
});

test("times, zones and dates are checked", () => {
  assert.ok(error({ waiverTime: "24:00" }));
  assert.ok(error({ waiverTime: "3:00" }));
  assert.ok(error({ timeZone: "Mars/Olympus" }));
  assert.ok(error({ timeZone: "EST" }));
  assert.equal(error({ timeZone: "America/Los_Angeles" }), null);
  assert.ok(error({ tradeDeadline: "2027-02-30x" }));
  assert.equal(error({ tradeDeadline: "2027-02-05" }), null);
});

test("an IL slot needs a status that can use it", () => {
  assert.ok(error({ ilStatuses: [] }));
  assert.equal(error({ ilSlots: 0, ilStatuses: [] }), null);
  assert.ok(error({ ilPlusSlots: 1 }));
  assert.ok(error({ ilStatuses: ["Healthy"] }));
});

test("veto votes leave out the two teams in the trade", () => {
  assert.equal(error({ tradeVetoVotes: 10 }), null);
  assert.ok(error({ tradeVetoVotes: 11 }));
  assert.ok(error({ tradeVetoVotes: 0 }));
});

test("add limits are a count or unlimited", () => {
  assert.equal(error({ maxAddsPerWeek: null, maxAddsPerSeason: 50 }), null);
  assert.ok(error({ maxAddsPerWeek: -1 }));
  assert.ok(error({ maxAddsPerSeason: 1.5 }));
});

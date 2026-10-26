// Run: npx tsx --test src/lib/queries/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LeagueSettings } from "../types";
import { parseSettings } from "./settings";

const valid: LeagueSettings = {
  waiverType: "continual_rolling", waiverTime: "03:00", timeZone: "America/New_York",
  waiverDaysOfWeek: [1, 2, 3, 4, 5, 6, 7], waiverDays: 2, waiversAfterGameStart: false,
  faabBudget: 100, faabMinBid: 0,
  ilSlots: 2, ilStatuses: ["Out"], ilPlusSlots: 0, ilPlusStatuses: [],
  tradeReview: "league_vote", tradeReviewDays: 2, tradeVetoVotes: 4, tradeDeadline: null,
  maxAddsPerWeek: 4, maxAddsPerSeason: null,
  playoffTeams: 8, playoffStartWeek: 22, toiletBowl: true, toiletBowlTeams: 4,
  gameLimits: null,
};

const error = (over: Partial<Record<keyof LeagueSettings, unknown>>) => {
  const r = parseSettings({ ...valid, ...over }, 12, 24);
  return "error" in r ? r.error : null;
};

test("the seeded settings are valid", () => {
  assert.deepEqual(parseSettings(valid, 12, 24), { settings: valid });
});

test("weekdays and statuses come back sorted and deduplicated", () => {
  const r = parseSettings({ ...valid, waiverDaysOfWeek: [5, 2, 5], ilStatuses: ["Day-To-Day", "Out"] }, 12, 24);
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

test("playoff and toilet bowl teams fit the league", () => {
  assert.ok(error({ playoffTeams: 9 }));
  // 9 teams is 4 rounds (byes for the top 7), so it starts by week 21.
  assert.equal(error({ playoffTeams: 9, toiletBowl: false, playoffStartWeek: 21 }), null);
  assert.equal(error({ playoffTeams: 6, toiletBowlTeams: 6 }), null);
  assert.ok(error({ playoffTeams: 13, toiletBowl: false }));
  assert.ok(error({ playoffTeams: 1 }));
  assert.ok(error({ toiletBowlTeams: 1 }));
  // 8 toilet bowl teams would be 3 rounds against the 4-team playoffs' 2.
  assert.ok(error({ playoffTeams: 4, toiletBowlTeams: 8 }));
  assert.ok(error({ toiletBowl: "yes" }));
});

test("the playoff weeks fit the schedule", () => {
  // 8 teams = 3 rounds: weeks 22-24 of 24 at the latest.
  assert.ok(error({ playoffStartWeek: 23 }));
  assert.equal(error({ playoffStartWeek: 20 }), null);
  assert.equal(error({ playoffTeams: 4, playoffStartWeek: 23 }), null);
  assert.ok(error({ playoffStartWeek: 1 }));
  assert.ok(error({ playoffStartWeek: null }));
  assert.ok("error" in parseSettings(valid, 12, 3));
});

test("FAAB budget and minimum bid: whole dollars, the minimum within the budget", () => {
  assert.equal(error({ faabBudget: 200, faabMinBid: 1 }), null);
  assert.equal(error({ faabMinBid: 100 }), null);
  assert.match(error({ faabBudget: 0 })!, /budget/);
  assert.match(error({ faabBudget: 1001 })!, /budget/);
  assert.match(error({ faabBudget: 50.5 })!, /budget/);
  assert.match(error({ faabMinBid: -1 })!, /minimum bid/);
  assert.match(error({ faabMinBid: 101 })!, /minimum bid must be \$0–\$100/);
  assert.match(error({ faabMinBid: undefined })!, /minimum bid/);
});

test("game limits: off, or a total with optional per-slot caps", () => {
  assert.equal(error({ gameLimits: { total: 40, slots: { C: 8 } } }), null);
  assert.ok(error({ gameLimits: { total: 0, slots: {} } }));
  assert.ok(error({ gameLimits: { total: 40, slots: { IL: 2 } } }));
  const r = parseSettings({ ...valid, gameLimits: { total: 40, slots: { UTIL: null, C: 8, PG: 5 } } }, 12, 24);
  assert.ok("settings" in r);
  assert.deepEqual(r.settings.gameLimits, { total: 40, slots: { PG: 5, C: 8 } });
});

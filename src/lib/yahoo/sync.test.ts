import assert from "node:assert/strict";
import { test } from "node:test";
import { dueScope } from "./sync";

const H = 3_600_000;
const now = Date.UTC(2026, 10, 17, 20);
const at = (hoursAgo: number) => new Date(now - hoursAgo * H);

test("dueScope: full daily, on a new week or without a cache; scoreboard hourly; else rosters", () => {
  const base = { cache: { settings: {}, teams: {}, gameWeeks: {} }, lastFullAt: at(2), lastScoreboardAt: at(0.2), lastWeek: 5 };
  assert.equal(dueScope(base, 5, now), "rosters");
  assert.equal(dueScope({ ...base, lastScoreboardAt: at(1) }, 5, now), "scoreboard");
  assert.equal(dueScope({ ...base, lastScoreboardAt: null }, 5, now), "scoreboard");
  assert.equal(dueScope({ ...base, lastFullAt: at(24) }, 5, now), "full");
  assert.equal(dueScope({ ...base, lastFullAt: null }, 5, now), "full");
  assert.equal(dueScope({ ...base, cache: null }, 5, now), "full");
  assert.equal(dueScope(base, 6, now), "full", "a week ended");
  assert.equal(dueScope(base, null, now), "rosters");
});

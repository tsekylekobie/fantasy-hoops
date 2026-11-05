// Run: npx tsx --test src/lib/transactions/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { addMode, dropDestination, waiverReason } from "./policy";

const league = { waiverDays: 2, waiversAfterGameStart: false, allAddsByClaim: false };
const free = { onWaivers: false, gameStarted: false };

test("a free agent not on waivers is added right away by default", () => {
  assert.equal(waiverReason(league, free), null);
  assert.equal(addMode(league, free), "immediate");
  assert.equal(addMode(league, { ...free, gameStarted: true }), "immediate");
});

test("recently dropped players and, with the setting, started games need a claim", () => {
  assert.equal(waiverReason(league, { ...free, onWaivers: true }), "dropped");
  assert.equal(waiverReason({ ...league, waiversAfterGameStart: true }, { ...free, gameStarted: true }), "game_started");
});

test("all adds by claim makes every add a claim, keeping the more specific reason", () => {
  const all = { ...league, allAddsByClaim: true };
  assert.equal(waiverReason(all, free), "all_adds");
  assert.equal(addMode(all, free), "waiver");
  assert.equal(waiverReason(all, { ...free, onWaivers: true }), "dropped");
  assert.equal(waiverReason({ ...all, waiversAfterGameStart: true }, { ...free, gameStarted: true }), "game_started");
  assert.equal(waiverReason(all, { ...free, gameStarted: true }), "all_adds");
});

test("drops go to waivers unless waiver days is 0", () => {
  assert.equal(dropDestination({ waiverDays: 2 }), "waivers");
  assert.equal(dropDestination({ waiverDays: 0 }), "free_agents");
});

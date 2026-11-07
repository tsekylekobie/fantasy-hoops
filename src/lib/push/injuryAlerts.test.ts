// Run: npx tsx --test src/lib/push/injuryAlerts.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { injuryAlert, injurySeverity, isCleared, isDowngrade, shouldAlert } from "./injuryAlerts";

test("a worse status is a downgrade", () => {
  assert.equal(isDowngrade(null, "Questionable"), true);
  assert.equal(isDowngrade("Questionable", "Out"), true);
  assert.equal(isDowngrade("Probable", "Doubtful"), true);
  assert.equal(isDowngrade("Available", "Day-To-Day"), true);
});

test("the same or a better status is not", () => {
  assert.equal(isDowngrade("Out", "Out"), false);
  assert.equal(isDowngrade("Out", "Questionable"), false);
  assert.equal(isDowngrade("Doubtful", null), false);
  assert.equal(isDowngrade(null, "Available"), false);
  assert.equal(isDowngrade("Day-To-Day", "Available"), false);
});

test("an unknown status ranks with Day-To-Day", () => {
  assert.equal(injurySeverity("Suspended"), injurySeverity("Day-To-Day"));
  assert.equal(isDowngrade(null, "Suspended"), true);
  assert.equal(isDowngrade("Suspended", "Out"), true);
});

test("the message names the change, the injury, the return and the team", () => {
  const m = injuryAlert({
    playerId: 7,
    playerName: "Derrick White",
    from: "Questionable",
    to: "Out",
    returnDate: "2026-11-20",
    description: "Injury/Illness - Left Calf Strain (2026-10-24, MIA@CHA). Prior reporting (2026-10-24): White (calf) has been ruled out.",
    teamName: "Splash Bros",
  });
  assert.equal(m.title, "Derrick White: Questionable → Out");
  assert.equal(m.body, "Left Calf Strain, est. return Nov 20. On Splash Bros.");
  assert.equal(m.tag, "injury-7");
  assert.equal(m.url, "/my-team");
});

test("off the report reads as Healthy, and missing details are left out", () => {
  const m = injuryAlert({ playerId: 1, playerName: "A B", from: null, to: "Day-To-Day", returnDate: null, description: null, teamName: "T" });
  assert.equal(m.title, "A B: Healthy → Day-To-Day");
  assert.equal(m.body, "On T.");
});

test("an injured player back to healthy is cleared", () => {
  assert.equal(isCleared("Out", null), true);
  assert.equal(isCleared("Day-To-Day", "Available"), true);
  assert.equal(isCleared("Probable", null), true);
  assert.equal(isCleared("Out", "Questionable"), false);
  assert.equal(isCleared(null, null), false);
  assert.equal(isCleared(null, "Available"), false);
});

test("alerts go out for downgrades and clearances, not partial upgrades", () => {
  assert.equal(shouldAlert("Questionable", "Out"), true);
  assert.equal(shouldAlert(null, "Day-To-Day"), true);
  assert.equal(shouldAlert("Out", null), true);
  assert.equal(shouldAlert("Doubtful", "Available"), true);
  assert.equal(shouldAlert("Out", "Questionable"), false);
  assert.equal(shouldAlert("Out", "Out"), false);
  assert.equal(shouldAlert(null, "Available"), false);
});

test("a cleared player's message says he's off the report", () => {
  const m = injuryAlert({ playerId: 7, playerName: "Derrick White", from: "Out", to: null, returnDate: null, description: null, teamName: "Splash Bros" });
  assert.equal(m.title, "Derrick White: Out → Healthy");
  assert.equal(m.body, "Off the injury report. On Splash Bros.");
  assert.equal(m.tag, "injury-7");
  const a = injuryAlert({ playerId: 7, playerName: "Derrick White", from: "Day-To-Day", to: "Available", returnDate: null, description: "x", teamName: "T" });
  assert.equal(a.title, "Derrick White: Day-To-Day → Healthy");
});

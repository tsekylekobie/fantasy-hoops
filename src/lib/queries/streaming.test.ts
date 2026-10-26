// Run: npx tsx --test src/lib/queries/streaming.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequest, parsePlayersQuery } from "./params";
import { addDays, clearsByTomorrow, playDates, streamDates, zonedDate } from "./streaming";

const ET = "America/New_York";
const PT = "America/Los_Angeles";

test("today is the league's calendar day, not UTC's", () => {
  // 02:30 UTC on Oct 26 is still Oct 25 in New York and Los Angeles.
  const at = new Date("2026-10-26T02:30:00Z");
  assert.equal(zonedDate(at, "UTC"), "2026-10-26");
  assert.deepEqual(streamDates(at, ET), { today: "2026-10-25", tomorrow: "2026-10-26", in2: "2026-10-27" });
  assert.deepEqual(streamDates(at, PT), { today: "2026-10-25", tomorrow: "2026-10-26", in2: "2026-10-27" });
  // 05:30 UTC: midnight has passed in New York but not in Los Angeles.
  const later = new Date("2026-10-26T05:30:00Z");
  assert.equal(streamDates(later, ET).today, "2026-10-26");
  assert.equal(streamDates(later, PT).today, "2026-10-25");
});

test("the day turns over at league midnight", () => {
  // EDT is UTC-4: 23:59:59 and 00:00:00 on either side of Oct 26.
  assert.equal(streamDates(new Date("2026-10-26T03:59:59Z"), ET).today, "2026-10-25");
  assert.equal(streamDates(new Date("2026-10-26T04:00:00Z"), ET).today, "2026-10-26");
});

test("windows cross month, year and DST boundaries by calendar day", () => {
  assert.deepEqual(streamDates(new Date("2026-10-30T16:00:00Z"), ET), { today: "2026-10-30", tomorrow: "2026-10-31", in2: "2026-11-01" });
  assert.deepEqual(streamDates(new Date("2026-12-30T16:00:00Z"), ET), { today: "2026-12-30", tomorrow: "2026-12-31", in2: "2027-01-01" });
  // DST ends Nov 1, 2026 (a 25-hour day): still one date per day.
  assert.deepEqual(streamDates(new Date("2026-11-01T04:30:00Z"), ET), { today: "2026-11-01", tomorrow: "2026-11-02", in2: "2026-11-03" });
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
});

test("chosen days map to dates in order, never further than in 2 days", () => {
  const dates = streamDates(new Date("2026-10-25T16:00:00Z"), ET);
  assert.deepEqual(playDates(["in2", "tomorrow"], dates), ["2026-10-26", "2026-10-27"]);
  assert.deepEqual(playDates([], dates), []);
  assert.deepEqual(Object.keys(dates), ["today", "tomorrow", "in2"]);
});

test("plays= accepts today, tomorrow and in2 only", () => {
  assert.deepEqual(parsePlayersQuery(new URLSearchParams()).plays, []);
  assert.deepEqual(parsePlayersQuery(new URLSearchParams("plays=in2,tomorrow,in2")).plays, ["tomorrow", "in2"]);
  assert.deepEqual(parsePlayersQuery(new URLSearchParams("plays=")).plays, []);
  for (const bad of ["in3", "yesterday", "today,in3", "3"]) {
    assert.throws(() => parsePlayersQuery(new URLSearchParams({ plays: bad })), BadRequest);
  }
});

test("waivers= accepts any, on and clears", () => {
  assert.equal(parsePlayersQuery(new URLSearchParams()).waivers, "any");
  assert.equal(parsePlayersQuery(new URLSearchParams("waivers=clears")).waivers, "clears");
  assert.throws(() => parsePlayersQuery(new URLSearchParams("waivers=soon")), BadRequest);
});

test("clears by tomorrow uses the league-time date the Claim button shows", () => {
  const now = new Date("2026-10-25T16:00:00Z"); // Sun Oct 25, noon ET
  // Runs at 3:00 AM ET Mon and Tue.
  assert.equal(clearsByTomorrow("2026-10-26T07:00:00Z", ET, now), true);
  assert.equal(clearsByTomorrow("2026-10-27T07:00:00Z", ET, now), false);
  // 11:30 PM ET Monday is 03:30 UTC Tuesday: still by the end of tomorrow.
  assert.equal(clearsByTomorrow("2026-10-27T03:30:00Z", ET, now), true);
  assert.equal(clearsByTomorrow("2026-10-27T04:00:00Z", ET, now), false);
  // Just before midnight Sunday, tomorrow is Monday; just after, it is Tuesday.
  assert.equal(clearsByTomorrow("2026-10-27T07:00:00Z", ET, new Date("2026-10-26T03:59:00Z")), false);
  assert.equal(clearsByTomorrow("2026-10-27T07:00:00Z", ET, new Date("2026-10-26T04:01:00Z")), true);
});

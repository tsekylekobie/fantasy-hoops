// Run: npx tsx --test src/components/players/format.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlayerInjury } from "@/lib/types";
import { fmtInjuryStatus, todayIn } from "./format";

const inj = (status: string, returnDate: string | null): PlayerInjury => ({ status, returnDate, injury: null, note: null });
const today = "2026-11-03";

test("Out shows how long until the estimated return", () => {
  assert.equal(fmtInjuryStatus(inj("Out", "2026-11-05"), today), "Out 2D");
  assert.equal(fmtInjuryStatus(inj("Out", "2026-11-16"), today), "Out 13D");
  assert.equal(fmtInjuryStatus(inj("Out", "2026-11-17"), today), "Out 2W");
  assert.equal(fmtInjuryStatus(inj("Out", "2026-12-01"), today), "Out 4W");
  assert.equal(fmtInjuryStatus(inj("Out", "2027-02-03"), today), "Out 3M");
});

test("falls back to the bare status", () => {
  assert.equal(fmtInjuryStatus(inj("Out", null), today), "Out");
  assert.equal(fmtInjuryStatus(inj("Out", "2026-11-03"), today), "Out");
  assert.equal(fmtInjuryStatus(inj("Out", "2026-10-30"), today), "Out");
  assert.equal(fmtInjuryStatus(inj("Doubtful", null), today), "Doubtful");
});

test("Day-To-Day shortens to DTD", () => {
  assert.equal(fmtInjuryStatus(inj("Day-To-Day", "2026-11-10"), today), "DTD");
  assert.equal(fmtInjuryStatus(inj("Day-to-day", null), today), "DTD");
});

test("Questionable shortens to Q", () => {
  assert.equal(fmtInjuryStatus(inj("Questionable", null), today), "Q");
  assert.equal(fmtInjuryStatus(inj("Questionable", "2026-11-05"), today), "Q");
});

test("todayIn uses the league's time zone", () => {
  const late = new Date("2026-11-04T02:30:00Z"); // 9:30 PM ET on Nov 3
  assert.equal(todayIn("America/New_York", late), "2026-11-03");
  assert.equal(todayIn("UTC", late), "2026-11-04");
});

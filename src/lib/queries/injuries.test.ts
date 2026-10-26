// Run: npx tsx --test src/lib/queries/injuries.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInjuryDescription, toPlayerInjury } from "./injuries";

test("splits the injury from the news blurb", () => {
  const r = parseInjuryDescription(
    "Injury/Illness - Left Calf Strain (2026-10-24, MIA@CHA). Prior reporting (2026-10-24): White (calf) has been ruled out for Saturday's game against Miami.",
  );
  assert.equal(r.injury, "Left Calf Strain");
  assert.equal(r.note, "White (calf) has been ruled out for Saturday's game against Miami.");
});

test("keeps unrecognized text whole as the note", () => {
  assert.deepEqual(parseInjuryDescription("Rest. Questionable for Monday."), { injury: null, note: "Rest. Questionable for Monday." });
  assert.deepEqual(parseInjuryDescription("  "), { injury: null, note: null });
  assert.deepEqual(parseInjuryDescription(null), { injury: null, note: null });
});

test("no status means healthy", () => {
  assert.equal(toPlayerInjury(null, "2026-11-01", null), null);
  assert.deepEqual(toPlayerInjury("Out", "2026-11-01", null), { status: "Out", returnDate: "2026-11-01", injury: null, note: null });
});

test("other report reasons and bare blurbs", () => {
  assert.deepEqual(parseInjuryDescription("G League - Two-Way (2026-10-24, HOU@ATL)."), { injury: "G League - Two-Way", note: null });
  assert.equal(parseInjuryDescription("Not With Team (2026-10-24, GSW@PHX). Prior reporting (2026-10-21): Porzingis is out.").injury, "Not With Team");
  assert.deepEqual(parseInjuryDescription("Beal (knee) will not be ready for the start of the regular season."), {
    injury: "Knee",
    note: "Beal (knee) will not be ready for the start of the regular season.",
  });
  assert.equal(parseInjuryDescription("Strus has been diagnosed with a partially torn plantar fascia.").injury, null);
});

test("Available means cleared", () => {
  assert.equal(toPlayerInjury("Available", null, "Injury/Illness - Left Finger Sprain (2026-10-24, MIA@CHA)."), null);
});

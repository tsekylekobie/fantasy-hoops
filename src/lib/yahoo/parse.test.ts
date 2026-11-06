// Run: npx tsx --test src/lib/yahoo/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { abbreviate, matchPlayer, normalizeName, parseCsv, toCsv, toNbaAbbr, type OurPlayer } from "./parse";

test("normalizeName and team abbreviations", () => {
  assert.equal(normalizeName("Nikola Jokić"), "nikola jokic");
  assert.equal(normalizeName("Jaren Jackson Jr."), "jaren jackson");
  assert.equal(normalizeName("Shai Gilgeous-Alexander"), "shai gilgeous alexander");
  assert.equal(normalizeName("De'Aaron Fox"), "deaaron fox");
  assert.equal(toNbaAbbr("GS"), "GSW");
  assert.equal(toNbaAbbr("Pho"), "PHX");
  assert.equal(toNbaAbbr("LAL"), "LAL");
});

test("matchPlayer: by name, then team, then initial", () => {
  const ours: OurPlayer[] = [
    { id: 1, firstName: "Nikola", lastName: "Jokic", team: "DEN" },
    { id: 2, firstName: "Jaren", lastName: "Jackson Jr.", team: "MEM" },
    { id: 3, firstName: "Marcus", lastName: "Morris", team: null },
    { id: 4, firstName: "Marcus", lastName: "Morris", team: "CLE" },
    { id: 5, firstName: "Nicolas", lastName: "Claxton", team: "BKN" },
    { id: 6, firstName: "Jalen", lastName: "Williams", team: "OKC" },
    { id: 7, firstName: "Jalen", lastName: "Williams", team: "DEN" },
    { id: 8, firstName: "Trey", lastName: "Murphy", team: "NOP" },
    { id: 9, firstName: "Trey", lastName: "Murphy III", team: "NOP" },
  ];
  const y = (full: string, first: string, last: string, team: string) => ({ key: "k", full, first, last, team, eligiblePositions: [] });
  assert.equal(matchPlayer(y("Nikola Jokić", "Nikola", "Jokic", "DEN"), ours), 1);
  assert.equal(matchPlayer(y("Jaren Jackson Jr.", "Jaren", "Jackson Jr.", "MEM"), ours), 2);
  assert.equal(matchPlayer(y("Marcus Morris Sr.", "Marcus", "Morris Sr.", "CLE"), ours), 4);
  assert.equal(matchPlayer(y("Nic Claxton", "Nic", "Claxton", "BKN"), ours), 5);
  assert.equal(matchPlayer(y("Jalen Williams", "Jalen", "Williams", "OKC"), ours), 6);
  assert.equal(matchPlayer(y("Jalen Williams", "Jalen", "Williams", ""), ours), null);
  assert.equal(matchPlayer(y("Trey Murphy III", "Trey", "Murphy III", "NO"), ours), 9);
  assert.equal(matchPlayer(y("Nobody Here", "Nobody", "Here", "LAL"), ours), null);
});

test("CSV round trip with quotes and commas", () => {
  const csv = toCsv(["team", "email"], [{ team: 'The "Bigs", Inc', email: "a@gmail.com" }, { team: "Plain", email: null }]);
  assert.deepEqual(parseCsv(csv), [{ team: 'The "Bigs", Inc', email: "a@gmail.com" }, { team: "Plain", email: "" }]);
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n\r\n"), [{ a: "1", b: "2" }]);
});

test("abbreviate: initials, then letters, then numbered", () => {
  const taken = new Set<string>();
  assert.equal(abbreviate("Fast Break Fund", taken), "FBF");
  taken.add("FBF");
  assert.equal(abbreviate("Fast Break Fund", taken), "FAS");
  assert.equal(abbreviate("X", new Set()), "TM1");
  assert.match(abbreviate("Splash", new Set(["SPL", "SPLA"])), /^(?=.*[A-Z])[A-Z0-9]{2,4}$/);
});

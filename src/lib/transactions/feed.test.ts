// Run: npx tsx --test src/lib/transactions/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FantasyTeamSummary, LeagueTransaction, PlayerSummary, WaiverRunEntry } from "../types";
import { groupUnrunClaims, transactionFeed } from "./feed";

const team = (id: number, abbreviation: string): FantasyTeamSummary => ({ id, name: abbreviation, abbreviation, logoUrl: null });
const player = (id: number, lastName: string): PlayerSummary =>
  ({ id, firstName: "P", lastName, teamAbbr: null, position: null, nbaPersonId: null });
const A = team(1, "AAA");
const B = team(2, "BBB");

let nextId = 1;
const claim = (
  at: string, by: FantasyTeamSummary, add: PlayerSummary, drop: PlayerSummary | null, bid: number | null = null,
  failureReason: string | null = null,
): LeagueTransaction => ({
  id: nextId++, type: "waiver_claim", at, team: by, tradeTeam: null, faabBid: bid, failureReason,
  moves: [{ player: add, from: null, to: by }, ...(drop ? [{ player: drop, from: by, to: null }] : [])],
});
const addDrop = (at: string, by: FantasyTeamSummary, add: PlayerSummary): LeagueTransaction => ({
  id: nextId++, type: "add", at, team: by, tradeTeam: null, faabBid: null, failureReason: null, moves: [{ player: add, from: null, to: by }],
});

test("claims in the same minute become one report; other minutes get their own", () => {
  const { transactions, reports } = groupUnrunClaims([
    claim("2026-11-05T08:00:12Z", A, player(10, "Low"), player(11, "Gone"), 3),
    claim("2026-11-05T08:00:40Z", B, player(12, "High"), null, 20),
    claim("2026-11-06T08:00:05Z", A, player(13, "Next"), null, 1),
  ]);
  assert.equal(transactions.length, 0);
  assert.equal(reports.length, 2);
  const [first, second] = reports;
  assert.equal(first.id, null);
  assert.equal(first.at, "2026-11-05T08:00:40Z");
  assert.equal(first.faab, true);
  assert.deepEqual([first.won, first.failed], [2, 0]);
  // Highest bid first.
  assert.deepEqual(first.players.map((p) => p.player.lastName), ["High", "Low"]);
  assert.equal(first.players[1].claims[0].drop?.lastName, "Gone");
  assert.equal(first.players[1].claims[0].team.id, A.id);
  assert.equal(second.players.length, 1);
});

test("failed claims join the report of their minute, after the winner, with why they lost", () => {
  const C = team(3, "CCC");
  const { transactions, reports } = groupUnrunClaims([
    claim("2026-11-05T08:00:40Z", A, player(10, "Hot"), null, 20),
    claim("2026-11-05T08:00:40Z", B, player(10, "Hot"), player(11, "Keep"), 12, ""),
    claim("2026-11-05T08:00:40Z", C, player(10, "Hot"), null, 20, ""),
    claim("2026-11-05T08:00:40Z", C, player(12, "Nobody"), null, 3, "Roster was full."),
  ]);
  assert.equal(transactions.length, 0);
  assert.equal(reports.length, 1);
  const [r] = reports;
  assert.deepEqual([r.won, r.failed], [1, 3]);
  // The player someone won first; within him the winner, then by bid.
  assert.deepEqual(r.players.map((p) => p.player.lastName), ["Hot", "Nobody"]);
  assert.deepEqual(r.players[0].claims.map((c) => [c.team.abbreviation, c.won, c.reason]), [
    ["AAA", true, null],
    ["CCC", false, "Tied at $20; AAA had priority."],
    ["BBB", false, "Outbid by AAA at $20."],
  ]);
  assert.equal(r.players[0].claims[2].drop?.lastName, "Keep");
  // A reason the import had stays; with no winner there's nobody to have lost to.
  assert.deepEqual(r.players[1].claims.map((c) => [c.won, c.reason]), [[false, "Roster was full."]]);
});

test("failed claims without bids lost on waiver order; a report of only failures", () => {
  const { reports } = groupUnrunClaims([
    claim("2026-11-05T08:00:00Z", A, player(10, "X"), null),
    claim("2026-11-05T08:00:00Z", B, player(10, "X"), null, null, ""),
    claim("2026-11-06T08:00:00Z", B, player(11, "Y"), null, null, ""),
  ]);
  assert.equal(reports[0].players[0].claims[1].reason, "AAA was ahead in the waiver order.");
  assert.deepEqual([reports[1].won, reports[1].failed], [0, 1]);
  assert.equal(reports[1].players[0].claims[0].reason, null);
});

test("claims without bids aren't FAAB", () => {
  const { reports } = groupUnrunClaims([claim("2026-11-05T08:00:00Z", A, player(10, "X"), null)]);
  assert.equal(reports[0].faab, false);
  assert.equal(reports[0].players[0].claims[0].bid, null);
});

test("the feed mixes transactions, runs and grouped claims newest first", () => {
  const run: WaiverRunEntry = { id: 7, at: "2026-11-07T08:00:00Z", faab: false, won: 1, failed: 1, players: [] };
  const lost: WaiverRunEntry = { id: 8, at: "2026-11-07T09:00:00Z", faab: false, won: 0, failed: 2, players: [] };
  const feed = transactionFeed(
    [
      addDrop("2026-11-08T01:00:00Z", A, player(20, "Add")),
      claim("2026-11-05T08:00:00Z", B, player(21, "Claim"), null),
      addDrop("2026-11-06T01:00:00Z", B, player(22, "Older")),
      claim("2026-11-04T08:00:00Z", A, player(23, "Lost"), null, null, ""),
    ],
    [run, lost],
  );
  // Runs and grouped claims where nothing went through aren't listed.
  assert.deepEqual(
    feed.map((e) => (e.kind === "tx" ? `tx:${e.tx.moves[0].player.lastName}` : `run:${e.run.id}`)),
    ["tx:Add", "run:7", "tx:Older", "run:null"],
  );
});

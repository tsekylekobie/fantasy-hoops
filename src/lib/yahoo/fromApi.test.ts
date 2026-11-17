// Fixtures (fixtures/*.json) follow the Yahoo Fantasy API's documented JSON
// (?format=json) for a made-up 4-team league, 466.l.12345, on 2026-11-17 (week 5).
// They are not captured responses: check them against real ones once the app
// has a key (README, "Yahoo API: what we assume").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  leagueFromApi,
  leagueMeta,
  lineFromStats,
  list,
  merge,
  rosterFromApi,
  scoreboardFromApi,
  snapshotFromApi,
  standingsFromApi,
  teamsFromApi,
  transactionsFromApi,
  userLeaguesFromApi,
  utcMinute,
  weeksFromApi,
} from "./fromApi";

const fx = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, "fixtures", `${name}.json`), "utf8"));

test("merge and list read Yahoo's arrays of one-key objects and numbered collections", () => {
  assert.deepEqual(merge([[{ a: 1 }, [], { b: "2" }], { c: 3 }]), { a: 1, b: "2", c: 3 });
  assert.deepEqual(list({ "1": { x: "b" }, "0": { x: "a" }, count: 2 }, "x"), ["a", "b"]);
  assert.deepEqual(list([{ x: 1 }, { y: 2 }], "x"), [1]);
  assert.deepEqual(list(undefined, "x"), []);
});

test("leagueMeta and leagueFromApi: settings, slots, scored stats (display-only ones left out)", () => {
  const meta = leagueMeta(fx("settings"));
  assert.equal(meta.key, "466.l.12345");
  assert.equal(meta.gameKey, "466");
  assert.equal(meta.currentWeek, 5);
  assert.equal(meta.season, 2026);
  const l = leagueFromApi(fx("settings"));
  assert.deepEqual(l.rosterSlots, { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 2, UTIL: 2, BN: 3, IL: 2, "IL+": 1 });
  assert.deepEqual([...l.statIds].sort(), ["10", "12", "15", "16", "17", "18", "19", "5", "8"]);
  assert.equal(l.playoffStartWeek, 18);
  assert.deepEqual(l.settings, {
    waiverType: "faab", waiverDays: 2, tradeReview: "commissioner", tradeReviewDays: 2, tradeDeadline: "2027-02-19",
    maxAddsPerWeek: 4, playoffTeams: 4,
  });
  assert.equal(l.startDate, "2026-10-20");
  assert.equal(l.endWeek, 20);
});

test("weeksFromApi: the league's weeks only", () => {
  const w = weeksFromApi(fx("game_weeks"), 1, 20);
  assert.equal(w.length, 20);
  assert.deepEqual(w[4], { week: 5, start: "2026-11-17", end: "2026-11-23" });
});

test("teamsFromApi and standingsFromApi", () => {
  const teams = teamsFromApi(fx("teams"));
  assert.equal(teams.length, 4);
  assert.deepEqual(teams[0], {
    key: "466.l.12345.t.1", name: "Splash Zone", waiverPriority: 3, faabBalance: 87,
    managers: [{ nickname: "Kobe", email: "kobe@example.com", isCommissioner: true }],
  });
  assert.equal(teams[1].managers[0].email, null);
  const st = standingsFromApi(fx("standings"));
  assert.deepEqual(st[2], { key: "466.l.12345.t.3", rank: 4, wins: 12, losses: 22, ties: 2 });
});

test("lineFromStats: makes/attempts from the display-only splits, blanks as zero", () => {
  const line = lineFromStats({ stats: [
    { stat: { stat_id: "9004003", value: "250/531" } }, { stat: { stat_id: "5", value: ".471" } },
    { stat: { stat_id: "9007006", value: "/" } }, { stat: { stat_id: "8", value: "-" } },
    { stat: { stat_id: "10", value: "60" } }, { stat: { stat_id: "19", value: "" } },
  ] });
  assert.deepEqual(line, { fgm: 250, fga: 531, fgPct: 0.471, ftm: 0, fta: 0, ftPct: null, fg3m: 60, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0 });
  // Without the split, the percentage alone.
  assert.equal(lineFromStats({ stats: [{ stat: { stat_id: "5", value: "0.4567" } }] }).fgPct, 0.457);
});

test("scoreboardFromApi: matchups, status, totals and the week's dates", () => {
  const { matchups, weeks } = scoreboardFromApi(fx("scoreboard_week4"));
  assert.deepEqual(weeks, [{ week: 4, start: "2026-11-10", end: "2026-11-16" }]);
  assert.equal(matchups.length, 2);
  assert.equal(matchups[0].status, "postevent");
  assert.equal(matchups[0].isPlayoffs, false);
  assert.deepEqual(matchups[0].teams.map((t) => t.key), ["466.l.12345.t.1", "466.l.12345.t.2"]);
  assert.deepEqual(matchups[0].teams[0].line, { fgm: 250, fga: 531, fgPct: 0.471, ftm: 80, fta: 101, ftPct: 0.792, fg3m: 60, pts: 700, reb: 220, ast: 150, stl: 40, blk: 25, tov: 70 });
  const live = scoreboardFromApi(fx("scoreboard_week5")).matchups;
  assert.equal(live[0].status, "midevent");
  assert.equal(live[1].teams[0].line.fgPct, null);
});

test("rosterFromApi: players with Yahoo keys and the day's positions", () => {
  const r = rosterFromApi(fx("roster_team1"));
  assert.equal(r.teamKey, "466.l.12345.t.1");
  assert.equal(r.date, "2026-11-17");
  assert.deepEqual(r.entries.map((e) => [e.player.key, e.position]), [
    ["466.p.4612", "PG"], ["466.p.5352", "C"], ["466.p.6014", "Util"], ["466.p.6692", "SG"], ["466.p.6950", "BN"],
  ]);
  assert.deepEqual(r.entries[2].player, {
    key: "466.p.6014", first: "Jaren", last: "Jackson Jr.", full: "Jaren Jackson Jr.", team: "MEM", eligiblePositions: ["PF", "C", "F", "Util"],
  });
});

test("transactionsFromApi: successful moves only, oldest first, claims and trades told apart", () => {
  const warnings: string[] = [];
  const txs = transactionsFromApi(fx("transactions"), warnings);
  assert.deepEqual(warnings, []);
  assert.deepEqual(txs.map((t) => [t.id.split(".tr.")[1], t.type, t.team.split(".t.")[1], t.tradeTeam?.split(".t.")[1] ?? null, t.faabBid]), [
    ["9", "add", "2", null, null],
    ["11", "drop", "2", null, null],
    ["12", "add", "2", null, null],
    ["13", "waiver_claim", "1", null, 12],
    ["14", "trade", "3", "4", null],
  ]);
  assert.equal(txs[0].at, utcMinute(1793900000));
  assert.equal(utcMinute(1793900000), "2026-11-05 17:33");
  // A drop's transaction_data is a bare object, an add's an array: both read.
  assert.deepEqual(txs[3].moves.map((m) => [m.player.key, m.from?.split(".t.")[1] ?? null, m.to?.split(".t.")[1] ?? null]), [
    ["466.p.6950", null, "1"], ["466.p.7001", "1", null],
  ]);
  assert.equal(txs[4].moves.length, 2);
});

test("userLeaguesFromApi: the connected account's NBA leagues", () => {
  assert.deepEqual(userLeaguesFromApi(fx("user_leagues")), [{ key: "466.l.12345", name: "Hoops Fixture League", season: 2026 }]);
});

test("snapshotFromApi: everything together; parts not fetched stay empty", () => {
  const rosters = ["1", "2", "3", "4"].map((i) => ({ date: "2026-11-17", json: fx(`roster_team${i}`) }));
  rosters.push({ date: "2026-11-18", json: fx("roster_team1_2026-11-18") });
  const { snapshot: s, warnings } = snapshotFromApi({
    settings: fx("settings"), teams: fx("teams"), gameWeeks: fx("game_weeks"), standings: fx("standings"),
    scoreboards: [fx("scoreboard_week5"), fx("scoreboard_week4")], rosters, transactions: [fx("transactions"), fx("transactions")],
  }, "2026-11-17", "2026-11-17T20:00:00Z");
  assert.deepEqual(warnings, []);
  assert.equal(s.meta.leagueKey, "466.l.12345");
  assert.equal(s.weeks.length, 20);
  assert.deepEqual(s.matchups.map((m) => m.week), [4, 4, 5, 5]);
  assert.deepEqual([...s.rosters.keys()], ["2026-11-17", "2026-11-18"]);
  assert.equal(s.rosters.get("2026-11-17")!.size, 4);
  assert.equal(s.transactions.length, 5, "pages are de-duplicated");
  assert.equal(s.transactionsTimeZone, "UTC");
  assert.equal(s.standings?.length, 4);

  const bare = snapshotFromApi({ settings: fx("settings"), teams: fx("teams") }, "2026-11-17", "x").snapshot;
  assert.equal(bare.rosters.size, 0);
  assert.equal(bare.matchups.length, 0);
  assert.equal(bare.standings, undefined);
});

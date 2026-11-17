// Run: npx tsx --test src/lib/espn/map.test.ts
// Fixtures are real ESPN responses, trimmed: data/samples/espn/.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  NBA_TEAMS,
  boxAthletes,
  easternDate,
  gameKey,
  injuryAthlete,
  injuryName,
  isStoredGame,
  madeAttempted,
  nbaAbbr,
  rosterAthlete,
  splitName,
  statusFields,
  toGame,
  toInjury,
  toStatLines,
  toTeam,
} from "./map";
import type {
  EspnInjuriesResponse,
  EspnRosterResponse,
  EspnScheduleResponse,
  EspnScoreboardResponse,
  EspnSummaryResponse,
  EspnTeamsResponse,
} from "./raw";

const sample = <T>(name: string): T => JSON.parse(readFileSync(join(process.cwd(), "data/samples/espn", name), "utf8")) as T;

test("all 30 ESPN teams map to our (BALLDONTLIE) ids", () => {
  const teams = sample<EspnTeamsResponse>("teams.json").sports[0].leagues[0].teams.map((t) => toTeam(t.team));
  assert.equal(teams.length, 30);
  assert.ok(teams.every((t) => t !== null && t.isCurrent && t.conference));
  assert.deepEqual(new Set(teams.map((t) => t!.id)), new Set(Object.values(NBA_TEAMS).map((t) => t.id)));
  const gsw = teams.find((t) => t!.abbreviation === "GSW")!;
  assert.equal(gsw.id, 10);
  assert.equal(gsw.espnId, 9);
  assert.equal(gsw.fullName, "Golden State Warriors");
  for (const [espn, ours] of [["GS", "GSW"], ["NY", "NYK"], ["SA", "SAS"], ["NO", "NOP"], ["UTAH", "UTA"], ["WSH", "WAS"], ["BOS", "BOS"]]) {
    assert.equal(nbaAbbr(espn), ours);
  }
});

test("roster athletes keep ESPN's names, position and jersey", () => {
  const r = sample<EspnRosterResponse>("roster-2.json");
  assert.deepEqual(rosterAthlete(r.athletes[0], 2), {
    espnId: 4433188, firstName: "Devin", lastName: "Carter", position: "G", jerseyNumber: "99", teamId: 2,
  });
});

test("scoreboard games: US date (ESPN's is UTC), season, teams, scores, final status", () => {
  const sb = sample<EspnScoreboardResponse>("scoreboard-20261116.json");
  const e = sb.events[0];
  assert.equal(e.date, "2026-11-17T00:00Z");
  assert.ok(isStoredGame(e));
  const g = toGame(e, 123, "2026-11-16");
  assert.equal(g.id, 123);
  assert.equal(g.espnId, 401909994);
  assert.equal(g.date, "2026-11-16");
  assert.equal(g.season, 2026);
  assert.equal(g.homeTeamId, 2); // BOS
  assert.equal(g.visitorTeamId, 22); // ORL
  assert.equal(g.homeTeamScore, 105);
  assert.equal(g.visitorTeamScore, 115);
  assert.equal(g.statusState, "final");
  assert.equal(g.time, "Final");
  assert.equal(g.postseason, false);
  assert.equal(g.datetime, "2026-11-17T00:00:00.000Z");
  // Without the queried date, the Eastern date of the tip-off.
  assert.equal(gameKey(e).date, "2026-11-16");
  // WSH is Washington, our WAS (30).
  assert.equal(toGame(sb.events[2], 1).homeTeamId, 30);
});

test("team schedules: object scores, scheduled games without scores", () => {
  const s = sample<EspnScheduleResponse>("schedule-2-2027-2.json").events!;
  const done = toGame(s[1], 1);
  assert.equal(done.date, "2026-10-23");
  assert.equal(done.homeTeamScore, 107);
  assert.equal(done.visitorTeamId, 20); // NY -> NYK
  const later = toGame(s[2], 2);
  assert.equal(later.statusState, "scheduled");
  assert.equal(later.homeTeamScore, null);
  assert.equal(later.time, null);
});

test("the NBA Cup final is marked the way classifyGames reads it", () => {
  const e = sample<EspnScoreboardResponse>("scoreboard-20251216.json").events[0];
  const g = toGame(e, 1, "2025-12-16");
  assert.equal(g.season, 2025);
  assert.equal((g.raw as { ist_stage: string | null }).ist_stage, "Championship");
  const regular = toGame(sample<EspnScoreboardResponse>("scoreboard-20261116.json").events[0], 1);
  assert.equal((regular.raw as { ist_stage: string | null }).ist_stage, null);
});

test("preseason and All-Star events aren't stored", () => {
  const e = sample<EspnScoreboardResponse>("scoreboard-20261116.json").events[0];
  assert.equal(isStoredGame({ ...e, season: { year: 2027, type: 1 } }), false);
  assert.equal(isStoredGame({ ...e, season: { year: 2027, type: 3 } }), true);
  const allStar = { ...e.competitions[0], competitors: e.competitions[0].competitors.map((c) => ({ ...c, team: { id: "31", abbreviation: "LEB" } })) };
  assert.equal(isStoredGame({ ...e, competitions: [allStar] }), false);
});

test("live status: clock, halftime, end of a period, overtime", () => {
  const live = (name: string, period: number, displayClock = "7:23") =>
    statusFields({ period, displayClock, type: { name, state: "in", description: "In Progress" } });
  assert.deepEqual(live("STATUS_IN_PROGRESS", 3), { status: "In Progress", statusState: "in_progress", period: 3, time: "Q3 7:23", postponed: false });
  assert.equal(live("STATUS_HALFTIME", 2).time, "Halftime");
  assert.equal(live("STATUS_END_PERIOD", 1).time, "End Q1");
  assert.equal(live("STATUS_IN_PROGRESS", 5, "2:10").time, "OT 2:10");
  assert.equal(live("STATUS_IN_PROGRESS", 6, "0:40").time, "2OT 0:40");
  const pp = statusFields({ type: { name: "STATUS_POSTPONED", state: "post", description: "Postponed" } });
  assert.equal(pp.postponed, true);
  assert.equal(pp.statusState, "scheduled");
  assert.equal(statusFields({ period: 5, type: { name: "STATUS_FINAL", state: "post", description: "Final" } }).period, 5);
});

test("box score stat lines: makes-attempts, minutes, plus-minus, DNPs as zeros", () => {
  const s = sample<EspnSummaryResponse>("summary-401909994.json");
  const athletes = boxAthletes(s);
  const players = new Map(athletes.map((a, i) => [a.espnId, 1000 + i]));
  const lines = toStatLines(s, { gameId: 77, players });
  assert.equal(lines.length, athletes.length);
  const franz = lines.find((l) => l.player.espnId === 4566434)!;
  assert.deepEqual(
    { min: franz.min, pts: franz.pts, fgm: franz.fgm, fga: franz.fga, fg3m: franz.fg3m, fg3a: franz.fg3a, ftm: franz.ftm, fta: franz.fta,
      reb: franz.reb, ast: franz.ast, turnover: franz.turnover, stl: franz.stl, blk: franz.blk, oreb: franz.oreb, dreb: franz.dreb,
      pf: franz.pf, plusMinus: franz.plusMinus },
    { min: 38, pts: 21, fgm: 8, fga: 21, fg3m: 0, fg3a: 2, ftm: 5, fta: 5, reb: 8, ast: 9, turnover: 4, stl: 0, blk: 1, oreb: 0, dreb: 8, pf: 0, plusMinus: 14 },
  );
  assert.equal(franz.id, null);
  assert.equal(franz.gameId, 77);
  assert.equal(franz.teamId, 22); // ORL
  assert.equal(franz.season, 2026);
  assert.equal(franz.player.firstName, "Franz");
  assert.equal(franz.game.date, "2026-11-16");
  assert.equal(franz.game.homeTeamId, 2);
  const carter = lines.find((l) => l.player.espnId === 4277847)!;
  assert.equal(carter.player.lastName, "Carter Jr.");
  const dnp = lines.find((l) => l.player.espnId === 4593034)!;
  assert.equal(dnp.min, 0);
  assert.equal(dnp.pts, 0);
  assert.equal(dnp.plusMinus, null);
  // Players without an id are left out.
  assert.equal(toStatLines(s, { gameId: 77, players: new Map() }).length, 0);
  // A row ESPN sends without an athlete id (seen on a DNP, 401810126) is skipped.
  const noId = structuredClone(s);
  noId.boxscore.players![0].statistics[0].athletes.push({ athlete: { shortName: "Olbrich" }, didNotPlay: true, stats: [] });
  assert.equal(boxAthletes(noId).length, athletes.length);
  assert.equal(toStatLines(noId, { gameId: 77, players }).length, lines.length);
});

test("injuries: athlete id from the links, injury from the details, status as ESPN has it", () => {
  const body = sample<EspnInjuriesResponse>("injuries.json");
  const landale = body.injuries[0].injuries[0];
  assert.deepEqual(injuryAthlete(landale), {
    espnId: 3146557, firstName: "Jock", lastName: "Landale", position: "C", jerseyNumber: null, teamId: 1,
  });
  const i = toInjury(landale, 55);
  assert.equal(i.playerId, 55);
  assert.equal(i.status, "Day-To-Day");
  assert.equal(i.returnDate, "2026-11-18");
  assert.equal(i.injury, "Right Hip Inflammation");
  assert.match(i.description!, /^Landale \(hip\) is out for Sunday's game against Bucks.* Landale missed four games/);
  const gueye = toInjury(body.injuries[0].injuries[2], 56);
  assert.equal(gueye.status, "Out");
  assert.equal(gueye.injury, "Left Foot Fracture");
  assert.equal(toInjury(body.injuries[1].injuries[0], 57).injury, "Rest");
  assert.equal(injuryName({ type: "Head", detail: "Not Specified" }), "Head");
  assert.equal(injuryName(undefined), null);
});

test("helpers", () => {
  assert.deepEqual(madeAttempted("12-19"), [12, 19]);
  assert.deepEqual(madeAttempted(undefined), [0, 0]);
  assert.deepEqual(madeAttempted("--"), [0, 0]);
  assert.deepEqual(splitName("Shai Gilgeous-Alexander"), { firstName: "Shai", lastName: "Gilgeous-Alexander" });
  assert.deepEqual(splitName("Nenê"), { firstName: "Nenê", lastName: "" });
  assert.equal(easternDate("2026-11-17T03:30Z"), "2026-11-16");
  assert.equal(easternDate("2026-11-17T17:00Z"), "2026-11-17");
});

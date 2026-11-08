// Run: npx tsx --test src/lib/yahoo/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { csvPlayer, snapshotFromCsv, type CsvFiles } from "./csv";

const files = (over: Partial<CsvFiles> = {}): CsvFiles => ({
  league: { name: "Hoops", season: 2026, today: "2026-11-04", rosterSlots: { PG: 1, C: 1, Util: 1, BN: 2, IL: 1 }, playoffStartWeek: 3 },
  teams: "team,name,abbreviation,email,commissioner,waiver_priority,faab_balance\n1,Splash Zone,SPZ,a@x.com,yes,2,\n2,\"Glass, Cleaners\",,b@x.com;c@x.com,,1,\n",
  schedule: "week,start,end,team_a,team_b\n1,2026-10-20,2026-10-26,1,2\n2,2026-10-27,2026-11-02,2,1\n3,2026-11-03,2026-11-09,,\n",
  results:
    "week,team,fgm,fga,ftm,fta,fg3m,pts,reb,ast,stl,blk,tov\n" +
    "1,1,100,200,30,40,25,300,150,80,20,10,40\n1,2,90,210,35,40,20,280,160,70,25,15,35\n" +
    "2,1,95,190,20,25,30,290,140,90,22,12,38\n2,2,88,200,40,50,18,270,170,60,18,20,30\n",
  rosters: "team,player,nba_team,positions,slot\n1,Stephen Curry,GS,PG/SG,PG\n1,Nikola Jokić,DEN,C,C\n2,Jaren Jackson Jr.,MEM,PF/C,Util\n",
  lineups: "date,team,player,nba_team,positions,slot\n2026-11-03,1,Stephen Curry,GS,PG/SG,BN\n",
  ...over,
});

test("csvPlayer: key from the normalized name and our team abbreviation", () => {
  assert.deepEqual(csvPlayer(" Jaren Jackson Jr. ", "mem", "PF/C"), {
    key: "jaren jackson|MEM", first: "Jaren", last: "Jackson Jr.", full: "Jaren Jackson Jr.", team: "MEM", eligiblePositions: ["PF", "C"],
  });
  assert.equal(csvPlayer("Stephen Curry", "GS").team, "GSW");
});

test("snapshotFromCsv: a complete folder", () => {
  const { snapshot: s, members, errors } = snapshotFromCsv(files());
  assert.deepEqual(errors, []);
  assert.equal(s.meta.today, "2026-11-04");
  assert.deepEqual(s.league.rosterSlots, { PG: 1, C: 1, UTIL: 1, BN: 2, IL: 1 });
  assert.equal(s.league.startDate, "2026-10-20");
  assert.equal(s.league.endDate, "2026-11-09");
  assert.equal(s.league.statIds.length, 9);
  assert.deepEqual(s.teams.map((t) => [t.key, t.name, t.waiverPriority, t.faabBalance]), [["csv.t.1", "Splash Zone", 2, null], ["csv.t.2", "Glass, Cleaners", 1, null]]);
  assert.deepEqual(members[1], { yahoo_team_key: "csv.t.2", email: "b@x.com;c@x.com", commissioner: "", abbreviation: "" });
  assert.equal(s.weeks.length, 3);
  // Week 3 has dates but no matchups (playoffs); weeks 1-2 are finished with results.
  assert.deepEqual(s.matchups.map((m) => [m.week, m.status, m.isPlayoffs]), [[1, "postevent", false], [2, "postevent", false]]);
  assert.deepEqual(s.matchups[0].teams[0].line, { fgm: 100, fga: 200, fgPct: 0.5, ftm: 30, fta: 40, ftPct: 0.75, fg3m: 25, pts: 300, reb: 150, ast: 80, stl: 20, blk: 10, tov: 40 });
  assert.deepEqual([...s.rosters.keys()], ["2026-11-03", "2026-11-04"]);
  assert.equal(s.rosters.get("2026-11-04")!.get("csv.t.1")!.length, 2);
  assert.equal(s.rosters.get("2026-11-03")!.get("csv.t.1")![0].position, "BN");
});

test("snapshotFromCsv: reports what's wrong", () => {
  const { errors } = snapshotFromCsv(files({
    results: "week,team,fgm,fga,ftm,fta,fg3m,pts,reb,ast,stl,blk,tov\n1,1,100,200,30,40,25,300,150,80,20,10,\n1,9,1,1,1,1,1,1,1,1,1,1,1\n",
    rosters: "team,player,nba_team,positions,slot\n1,Stephen Curry,GS,PG,Bench\n",
    lineups: "date,team,player,nba_team,positions,slot\n2026-11-04,1,Stephen Curry,GS,PG,BN\n",
  }));
  assert.ok(errors.some((e) => e.includes("results.csv row 2: tov missing")));
  assert.ok(errors.some((e) => e.includes('results.csv row 3: no team "9"')));
  assert.ok(errors.some((e) => e.includes('week 2 has ended but has no row for team "1"')));
  assert.ok(errors.some((e) => e.includes('slot "Bench"')));
  assert.ok(errors.some((e) => e.includes("lineups.csv row 2: date")));
  assert.ok(errors.some((e) => e.includes('rosters.csv: no players for team "2"')));
});

test("snapshotFromCsv: lineups set ahead, through the end of this week", () => {
  const schedule = "week,start,end,team_a,team_b\n1,2026-10-20,2026-10-26,1,2\n2,2026-10-27,2026-11-02,2,1\n3,2026-11-03,2026-11-09,1,2\n4,2026-11-10,2026-11-16,1,2\n";
  const lineups = (date: string) => `date,team,player,nba_team,positions,slot\n${date},1,Stephen Curry,GS,PG/SG,Util\n`;
  const ahead = snapshotFromCsv(files({ schedule, lineups: lineups("2026-11-09") }));
  assert.deepEqual(ahead.errors, []);
  assert.equal(ahead.snapshot.rosters.get("2026-11-09")!.get("csv.t.1")![0].position, "Util");
  assert.ok(snapshotFromCsv(files({ schedule, lineups: lineups("2026-11-10") })).errors.some((e) => e.includes("lineups.csv row 2: date")));
});

test("snapshotFromCsv: weeks must be numbered in order without gaps", () => {
  const { errors } = snapshotFromCsv(files({ schedule: "week,start,end,team_a,team_b\n1,2026-10-20,2026-10-26,1,2\n3,2026-11-03,2026-11-09,1,2\n" }));
  assert.ok(errors.some((e) => e.includes("week 2 is missing")));
});

const TX = "id,at,type,player,nba_team,positions,from_team,to_team,faab_bid\n";

test("snapshotFromCsv: transactions grouped by id, oldest first", () => {
  const { snapshot: s, errors } = snapshotFromCsv(files({
    league: { name: "Hoops", season: 2026, today: "2026-11-04", rosterSlots: { PG: 1, BN: 2 }, transactionsTimeZone: "UTC" },
    transactions: TX +
      "2,2026-11-03 16:24,waiver_claim,Jaren Jackson Jr.,MEM,PF/C,,2,7\n2,2026-11-03 16:24,waiver_claim,Gui Santos,GS,F,2,,\n" +
      "1,2026-10-29 15:28,trade,Stephen Curry,GS,PG,2,1,\n1,2026-10-29 15:28,trade,Nikola Jokić,DEN,C,1,2,\n" +
      "3,2026-11-04 01:00,drop,\"Payton, Gary II\",GS,G/F,1,,\n",
  }));
  assert.deepEqual(errors, []);
  assert.equal(s.transactionsTimeZone, "UTC");
  assert.deepEqual(s.transactions.map((t) => [t.id, t.type, t.team, t.tradeTeam, t.faabBid, t.moves.length]), [
    ["1", "trade", "csv.t.2", "csv.t.1", null, 2],
    ["2", "waiver_claim", "csv.t.2", null, 7, 2],
    ["3", "drop", "csv.t.1", null, null, 1],
  ]);
  assert.deepEqual(s.transactions[1].moves.map((m) => [m.player.key, m.from, m.to]), [
    ["jaren jackson|MEM", null, "csv.t.2"], ["gui santos|GSW", "csv.t.2", null],
  ]);
  assert.equal(snapshotFromCsv(files()).snapshot.transactions.length, 0);
});

test("snapshotFromCsv: reports what's wrong with transactions", () => {
  const { errors } = snapshotFromCsv(files({
    transactions: TX +
      "1,2026-11-03,add,A B,MEM,F,,1,\n" +
      "2,2026-11-03 10:00,swap,A B,MEM,F,,1,\n" +
      "3,2026-11-03 10:00,add,A B,MEM,F,,,\n" +
      "4,2026-11-03 10:00,trade,A B,MEM,F,,1,\n" +
      "5,2026-11-03 10:00,add,A B,MEM,F,,1,\n5,2026-11-03 10:00,add,C D,MEM,F,,2,\n" +
      "6,2026-11-03 10:00,add,A B,MEM,F,,9,\n",
  }));
  assert.ok(errors.some((e) => e.includes('row 2: at "2026-11-03"')));
  assert.ok(errors.some((e) => e.includes('row 3: type "swap"')));
  assert.ok(errors.some((e) => e.includes("row 4: from_team and to_team are both blank")));
  assert.ok(errors.some((e) => e.includes("row 5: a trade moves")));
  assert.ok(errors.some((e) => e.includes("transaction 5 moves players for 2 teams")));
  assert.ok(errors.some((e) => e.includes('row 8: no team "9"')));
});

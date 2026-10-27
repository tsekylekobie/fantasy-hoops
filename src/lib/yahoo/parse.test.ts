// Run: npx tsx --test src/lib/yahoo/*.test.ts
// Fixtures follow the Yahoo Fantasy API's JSON shapes (fragments + "0"/"count" collections).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  abbreviate,
  matchPlayer,
  normalizeName,
  parseCsv,
  parseLeague,
  parseRoster,
  parseScoreboard,
  parseTeams,
  parseTransactions,
  toCsv,
  toNbaAbbr,
  type OurPlayer,
} from "./parse";

const player = (key: string, full: string, first: string, last: string, team: string, positions: string[]) => [
  { player_key: key },
  { player_id: key.split(".p.")[1] },
  { name: { full, first, last, ascii_first: first, ascii_last: last } },
  [],
  { editorial_team_abbr: team },
  { display_position: positions.join(",") },
  { eligible_positions: positions.map((position) => ({ position })) },
];

test("parseRoster: players and their positions that day", () => {
  const json = {
    fantasy_content: {
      team: [
        [{ team_key: "466.l.1.t.1" }, { team_id: "1" }, { name: "Splash Zone" }],
        {
          roster: {
            coverage_type: "date", date: "2026-11-02",
            0: {
              players: {
                0: { player: [player("466.p.1", "Nikola Jokić", "Nikola", "Jokic", "Den", ["C"]), { selected_position: [{ coverage_type: "date" }, { position: "C" }] }] },
                1: { player: [player("466.p.2", "Stephen Curry", "Stephen", "Curry", "GS", ["PG", "SG", "G"]), { selected_position: [{ coverage_type: "date" }, { position: "Util" }] }] },
                count: 2,
              },
            },
          },
        },
      ],
    },
  };
  const roster = parseRoster(json);
  assert.equal(roster.length, 2);
  assert.deepEqual(roster[0].player, { key: "466.p.1", first: "Nikola", last: "Jokic", full: "Nikola Jokić", team: "DEN", eligiblePositions: ["C"] });
  assert.equal(roster[1].position, "Util");
  assert.equal(roster[1].player.team, "GS");
});

test("parseTeams: waiver order, FAAB and managers", () => {
  const json = {
    fantasy_content: {
      league: [
        { league_key: "466.l.1" },
        {
          teams: {
            0: {
              team: [[
                { team_key: "466.l.1.t.3" }, { team_id: "3" }, { name: "Glass Cleaners" }, [], { waiver_priority: 5 }, { faab_balance: "87" },
                { managers: [{ manager: { manager_id: "3", nickname: "Theo", is_commissioner: "1", email: "theo@gmail.com" } }] },
              ]],
            },
            count: 1,
          },
        },
      ],
    },
  };
  assert.deepEqual(parseTeams(json), [{
    key: "466.l.1.t.3", name: "Glass Cleaners", waiverPriority: 5, faabBalance: 87,
    managers: [{ nickname: "Theo", email: "theo@gmail.com", isCommissioner: true }],
  }]);
});

const stats = (pairs: [string, string][]) => ({ coverage_type: "week", week: "1", stats: pairs.map(([stat_id, value]) => ({ stat: { stat_id, value } })) });

test("parseScoreboard: each side's week line, percentages from makes/attempts", () => {
  const side = (key: string, s: ReturnType<typeof stats>) => ({ team: [[{ team_key: key }, { name: key }], { team_stats: s }] });
  const json = {
    fantasy_content: {
      league: [
        { league_key: "466.l.1" },
        {
          scoreboard: {
            week: "1",
            0: {
              matchups: {
                0: {
                  matchup: {
                    week: "1", status: "postevent", is_playoffs: "0",
                    0: {
                      teams: {
                        0: side("t.1", stats([["9004003", "200/400"], ["5", ".500"], ["9007006", "75/100"], ["8", ".750"], ["10", "40"], ["12", "550"], ["15", "220"], ["16", "130"], ["17", "30"], ["18", "25"], ["19", "60"]])),
                        1: side("t.2", stats([["9004003", "-/-"], ["5", "-"], ["10", "-"]])),
                        count: 2,
                      },
                    },
                  },
                },
                count: 1,
              },
            },
          },
        },
      ],
    },
  };
  const [m] = parseScoreboard(json);
  assert.equal(m.week, 1);
  assert.equal(m.status, "postevent");
  assert.equal(m.isPlayoffs, false);
  assert.deepEqual(m.teams[0].line, {
    fgm: 200, fga: 400, fgPct: 0.5, ftm: 75, fta: 100, ftPct: 0.75, fg3m: 40, pts: 550, reb: 220, ast: 130, stl: 30, blk: 25, tov: 60,
  });
  // No games: zeros and no percentages.
  assert.equal(m.teams[1].line.fgPct, null);
  assert.equal(m.teams[1].line.fg3m, 0);
});

test("parseLeague: roster slots, scored stats and the settings we keep", () => {
  const json = {
    fantasy_content: {
      league: [
        { league_key: "466.l.1", name: "Hoops", season: "2026", num_teams: 12, start_week: "1", end_week: "21", start_date: "2026-10-20", end_date: "2027-04-11" },
        {
          settings: [{
            uses_playoff: "1", playoff_start_week: "19", num_playoff_teams: "6", uses_faab: "1", waiver_time: "2",
            trade_end_date: "2027-02-20", trade_ratify_type: "vote", trade_reject_time: "2", max_weekly_adds: "4", max_adds: "",
            roster_positions: [
              { roster_position: { position: "PG", count: 1 } }, { roster_position: { position: "Util", count: 2 } },
              { roster_position: { position: "BN", count: 3 } }, { roster_position: { position: "IL", count: 2 } },
              { roster_position: { position: "IL+", count: 1 } },
            ],
            stat_categories: { stats: [
              { stat: { stat_id: 9004003, enabled: "1", is_only_display_stat: "1" } },
              { stat: { stat_id: 5, enabled: "1" } }, { stat: { stat_id: 19, enabled: "1" } },
            ] },
          }],
        },
      ],
    },
  };
  const l = parseLeague(json);
  assert.equal(l.season, 2026);
  assert.deepEqual(l.rosterSlots, { PG: 1, UTIL: 2, BN: 3, IL: 2, "IL+": 1 });
  assert.deepEqual(l.statIds, ["5", "19"]);
  assert.equal(l.playoffStartWeek, 19);
  assert.deepEqual(l.settings, {
    waiverType: "faab", waiverDays: 2, tradeReview: "league_vote", tradeReviewDays: 2, tradeDeadline: "2027-02-20",
    maxAddsPerWeek: 4, maxAddsPerSeason: null, playoffTeams: 6,
  });
});

test("parseTransactions: an add/drop's players and where they went", () => {
  const json = {
    fantasy_content: {
      league: [
        { league_key: "466.l.1" },
        {
          transactions: {
            0: {
              transaction: [
                { transaction_key: "466.l.1.tr.9", type: "add/drop", status: "successful", timestamp: "1761900000", faab_bid: "12" },
                {
                  players: {
                    0: { player: [player("466.p.1", "A B", "A", "B", "Bos", ["G"]), { transaction_data: [{ type: "add", source_type: "waivers", destination_type: "team", destination_team_key: "466.l.1.t.2" }] }] },
                    1: { player: [player("466.p.2", "C D", "C", "D", "Mia", ["F"]), { transaction_data: { type: "drop", source_type: "team", source_team_key: "466.l.1.t.2", destination_type: "waivers" } }] },
                    count: 2,
                  },
                },
              ],
            },
            count: 1,
          },
        },
      ],
    },
  };
  const [t] = parseTransactions(json);
  assert.equal(t.type, "add/drop");
  assert.equal(t.faabBid, 12);
  assert.equal(t.timestamp, 1761900000);
  assert.deepEqual(t.players.map((p) => [p.type, p.sourceType, p.sourceTeamKey, p.destinationType, p.destinationTeamKey]), [
    ["add", "waivers", null, "team", "466.l.1.t.2"],
    ["drop", "team", "466.l.1.t.2", "waivers", null],
  ]);
});

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

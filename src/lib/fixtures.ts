// Fictional sample data from the design mockup. The stub API routes serve this
// until the database-backed queries replace them; delete it once nothing imports it.
import type {
  CategoryLine,
  PlayerDetailResponse,
  PlayerRow,
  PlayersResponse,
  SeasonRow,
} from "./types";
import { CURRENT_SEASON } from "./types";

type Raw = [string, string, string, string, number, number, number, number, number, number, number, number, number, number, number];
// first, last, team, pos, gp, min, fg%, ft%, 3pm, pts, reb, ast, stl, blk, to
const RAW: Raw[] = [
  ["Marcus", "Delaney", "BOS", "SG/SF", 3, 35.0, 0.492, 0.857, 3.0, 29.0, 6.0, 5.3, 1.3, 0.7, 2.7],
  ["Tomas", "Veric", "DEN", "C", 3, 33.8, 0.612, 0.745, 0.4, 24.1, 12.3, 8.9, 1.2, 1.1, 3.4],
  ["Jalen", "Okoro", "OKC", "PG", 3, 34.6, 0.501, 0.904, 2.4, 27.8, 4.4, 7.2, 1.8, 0.4, 2.6],
  ["Devin", "Park", "MIN", "PF/C", 2, 32.1, 0.546, 0.801, 1.8, 21.3, 10.8, 3.1, 1.0, 2.2, 1.9],
  ["Andre", "Whitlock", "PHX", "SG", 3, 36.0, 0.458, 0.867, 3.9, 26.6, 4.9, 4.8, 1.1, 0.3, 2.9],
  ["Luis", "Ferrer", "MIA", "SF/PF", 2, 31.4, 0.527, 0.712, 1.2, 18.9, 8.2, 4.6, 1.6, 1.4, 1.8],
  ["Kofi", "Mensah", "MEM", "C", 3, 30.5, 0.668, 0.603, 0.0, 14.2, 11.5, 2.1, 0.8, 2.9, 1.4],
  ["Ryan", "Calloway", "NYK", "PG", 3, 33.0, 0.441, 0.925, 2.9, 19.7, 3.2, 8.1, 1.3, 0.2, 2.1],
  ["Isaiah", "Brandt", "CLE", "PF", 3, 28.9, 0.513, 0.768, 1.5, 16.4, 7.9, 2.8, 1.4, 1.0, 1.5],
  ["Nico", "Santoro", "LAL", "SF", 2, 32.7, 0.478, 0.834, 2.1, 20.2, 5.5, 4.0, 1.5, 0.5, 2.3],
];

function line(fgPct: number, ftPct: number, rest: number[], fga = 20, fta = 7): CategoryLine {
  const [fg3m, pts, reb, ast, stl, blk, tov] = rest;
  return {
    fgm: +(fga * fgPct).toFixed(1), fga, fgPct,
    ftm: +(fta * ftPct).toFixed(1), fta, ftPct,
    fg3m, pts, reb, ast, stl, blk, tov,
  };
}

export const samplePlayers: PlayerRow[] = RAW.map((r, i) => ({
  id: i + 1,
  rank: i + 1,
  firstName: r[0],
  lastName: r[1],
  teamAbbr: r[2],
  position: r[3],
  nbaPersonId: null,
  gp: r[4],
  min: r[5],
  stats: line(r[6], r[7], r.slice(8) as number[]),
  value: +(10 - i * 0.8).toFixed(2),
}));

export function samplePlayersResponse(page: number, perPage: number): PlayersResponse {
  return {
    season: CURRENT_SEASON,
    mode: "avg",
    page,
    perPage,
    total: samplePlayers.length,
    players: samplePlayers.slice((page - 1) * perPage, page * perPage),
  };
}

const pastSeason = (season: number, gp: number, min: number, l: CategoryLine): SeasonRow => ({ season, gp, min, ...l });

export function samplePlayerDetail(id: number): PlayerDetailResponse | null {
  const p = samplePlayers.find((x) => x.id === id);
  if (!p) return null;
  return {
    player: {
      id: p.id, firstName: p.firstName, lastName: p.lastName, teamAbbr: p.teamAbbr,
      position: p.position, nbaPersonId: null, teamName: null, availability: null,
    },
    season: CURRENT_SEASON,
    seasonAverages: { season: CURRENT_SEASON, gp: p.gp, min: p.min, ...p.stats },
    gameLog: [
      { gameId: 3, date: "2026-10-24", opponentAbbr: "ATL", home: false, result: "L", min: 35, fgm: 10, fga: 20, ftm: 5, fta: 6, fg3m: 4, pts: 29, reb: 6, ast: 5, stl: 1, blk: 1, tov: 3 },
      { gameId: 2, date: "2026-10-22", opponentAbbr: "ORL", home: true, result: "W", min: 34, fgm: 9, fga: 19, ftm: 6, fta: 7, fg3m: 2, pts: 26, reb: 5, ast: 6, stl: 1, blk: 0, tov: 2 },
      { gameId: 1, date: "2026-10-21", opponentAbbr: "CHI", home: false, result: "W", min: 36, fgm: 11, fga: 22, ftm: 7, fta: 8, fg3m: 3, pts: 32, reb: 7, ast: 5, stl: 2, blk: 1, tov: 3 },
    ],
    pastSeasons: [
      pastSeason(2025, 71, 34.1, line(0.478, 0.861, [2.8, 26.7, 5.8, 5.0, 1.2, 0.5, 2.6])),
      pastSeason(2024, 76, 33.2, line(0.471, 0.849, [2.5, 24.9, 5.4, 4.6, 1.1, 0.5, 2.5])),
      pastSeason(2023, 68, 31.0, line(0.465, 0.842, [2.1, 22.3, 5.0, 4.1, 1.0, 0.4, 2.3])),
    ],
  };
}

// GET /api/trades/analysis: the data the trade analyzer (src/lib/trades/analysis.ts)
// prices trades with, for two teams in the season's league. Every rostered
// player's per-game line and value in both windows (season, last 14 days, as on
// the Players page), with the viewer's punt weights and the defaults, plus each
// league team's active per-game totals for the category ranks.
import type { Pool } from "pg";
import { isIlSlot } from "../lineup/rules";
import { addPerGame, emptyPerGame } from "../trades/analysis";
import {
  CATEGORIES,
  DEFAULT_WEIGHTS,
  LINEUP_SLOTS,
  STARTING_SLOTS,
  type CategoryWeights,
  type LineupSlot,
  type PerGameLine,
  type TradeAnalysisPlayer,
  type TradeAnalysisResponse,
  type TradeAnalysisWindowLine,
} from "../types";
import { getLast14Window, getSeasonTotals, getTotalsSince } from "./players";
import { toTeamSummary, type TeamRow } from "./teamLogo";
import { TradeError, type TradeLeague } from "./trades";
import { valuePlayers, type SeasonTotals } from "./value";
import { getWeights } from "./weights";

type WindowLines = Map<number, TradeAnalysisWindowLine>;

function perGame(t: SeasonTotals): PerGameLine {
  const g = (x: number) => x / t.gp;
  return {
    fgm: g(t.fgm), fga: g(t.fga), ftm: g(t.ftm), fta: g(t.fta), fg3m: g(t.fg3m), pts: g(t.pts),
    reb: g(t.reb), ast: g(t.ast), stl: g(t.stl), blk: g(t.blk), tov: g(t.tov),
  };
}

function windowLines(totals: SeasonTotals[], weights: CategoryWeights): WindowLines {
  const played = totals.filter((t) => t.gp > 0);
  const mine = valuePlayers(played, weights);
  const plain = valuePlayers(played, DEFAULT_WEIGHTS);
  return new Map(played.map((t) => [t.playerId, {
    gp: t.gp, perGame: perGame(t), value: mine.get(t.playerId)!.value, defaultValue: plain.get(t.playerId)!.value,
  }]));
}

export async function getTradeAnalysis(
  pool: Pool, league: TradeLeague, userId: number, teamIds: [number, number],
): Promise<TradeAnalysisResponse> {
  if (teamIds[0] === teamIds[1]) throw new TradeError("Pick two different teams.", 400);
  const [{ rows: teams }, { rows: roster }, weights, window, seasonTotals] = await Promise.all([
    pool.query<TeamRow>(
      `SELECT id::int, name, abbreviation, logo_updated_at FROM fantasy_teams WHERE league_id = $1 AND id = ANY($2)`,
      [league.id, teamIds],
    ),
    pool.query<{
      team_id: number; id: number; first_name: string; last_name: string; position: string | null;
      nba_person_id: number | null; team_abbr: string | null; slot: LineupSlot;
    }>(
      `SELECT rp.fantasy_team_id::int AS team_id, p.id, p.first_name, p.last_name, nullif(p.position, '') AS position,
              p.nba_person_id, tm.abbreviation AS team_abbr, rp.slot
         FROM roster_players rp
         JOIN players p ON p.id = rp.player_id
         LEFT JOIN teams tm ON tm.id = p.team_id
        WHERE rp.league_id = $1`,
      [league.id],
    ),
    getWeights(pool, userId),
    getLast14Window(pool, league.season),
    getSeasonTotals(pool, league.season),
  ]);
  if (teams.length !== 2) throw new TradeError("No such team in this league.", 404);
  const season = windowLines(seasonTotals, weights);
  const last14 = window ? windowLines(await getTotalsSince(pool, league.season, window.from), weights) : new Map() as WindowLines;

  const toPlayer = (r: (typeof roster)[number]): TradeAnalysisPlayer => ({
    id: r.id, firstName: r.first_name, lastName: r.last_name, teamAbbr: r.team_abbr, position: r.position,
    nbaPersonId: r.nba_person_id, slot: r.slot, season: season.get(r.id) ?? null, last14: last14.get(r.id) ?? null,
  });

  // Every team's active per-game totals, for the ranks.
  const lineOf = new Map<number, { season: PerGameLine; last14: PerGameLine }>();
  const { rows: allTeams } = await pool.query<{ id: number }>(`SELECT id::int FROM fantasy_teams WHERE league_id = $1`, [league.id]);
  for (const t of allTeams) lineOf.set(t.id, { season: emptyPerGame(), last14: emptyPerGame() });
  for (const r of roster) {
    const t = lineOf.get(r.team_id);
    if (!t || isIlSlot(r.slot)) continue;
    const s = season.get(r.id), l = last14.get(r.id);
    if (s) t.season = addPerGame(t.season, s.perGame);
    if (l) t.last14 = addPerGame(t.last14, l.perGame);
  }

  const byId = new Map(teams.map((t) => [t.id, toTeamSummary(t)]));
  return {
    activeLimit: league.settings.activeLimit,
    slots: LINEUP_SLOTS.filter((s) => STARTING_SLOTS.includes(s) && (league.rosterSlots[s] ?? 0) > 0)
      .map((slot) => ({ slot, count: league.rosterSlots[slot]! })),
    weights,
    weightsAreDefault: CATEGORIES.every((c) => weights[c] === DEFAULT_WEIGHTS[c]),
    teams: teamIds.map((id) => ({
      ...byId.get(id)!,
      players: roster.filter((r) => r.team_id === id).map(toPlayer)
        .sort((a, b) => (b.season?.value ?? -Infinity) - (a.season?.value ?? -Infinity) || a.lastName.localeCompare(b.lastName)),
    })),
    league: [...lineOf].map(([teamId, l]) => ({ teamId, ...l })),
    last14: window,
  };
}

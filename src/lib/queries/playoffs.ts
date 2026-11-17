// Playoffs and the toilet bowl as rounds in `matchups` (bracket rows, which the
// Yahoo sync writes), and the League page's Playoffs view (the bracket rules
// are in src/lib/playoffs/bracket.ts). Before any bracket rows exist the view
// is a projection seeded from today's standings. Display only.
import {
  advancing, bracketLabel, bracketRounds, bracketSeeds, firstRound, outcome, roundName, roundWeek,
  type Pairing, type Played,
} from "../playoffs/bracket";
import type {
  Bracket, BracketGame, BracketKind, BracketRound, BracketTag, BracketTeam, FantasyTeamSummary, MatchupScore, PlayoffsView,
} from "../types";
import { scoreIn, type LinesByWeek, type PairRow, type WeekRow } from "./standings";

/** How big each bracket is. toiletBowlTeams is 0 when the toilet bowl is off. */
export interface BracketConfig {
  teamCount: number;
  playoffTeams: number;
  toiletBowlTeams: number;
}

/** A bracket matchup row (or a regular-season one, with bracket null). */
export interface BracketRow extends PairRow {
  bracket: BracketKind | null;
  bracket_round: number | null;
  bracket_slot: number | null;
  seed_a: number | null;
  seed_b: number | null;
  status: "upcoming" | "live" | "final";
  team_a_wins: number;
  team_b_wins: number;
  ties: number;
}

/** Every matchup in the league, regular season and brackets; $1 league. */
export const MATCHUP_ROWS_SQL = `SELECT week, team_a_id::int, team_b_id::int, bracket, bracket_round, bracket_slot, seed_a, seed_b,
         status, team_a_wins, team_b_wins, ties
    FROM matchups WHERE league_id = $1 ORDER BY week, bracket NULLS FIRST, bracket_round, bracket_slot, id`;

function seedsOf(kind: BracketKind, cfg: BracketConfig): number[] {
  const s = bracketSeeds(cfg.teamCount, cfg.playoffTeams, cfg.toiletBowlTeams);
  return kind === "playoffs" ? s.playoffs : s.toiletBowl;
}

const roundsOf = (kind: BracketKind, cfg: BracketConfig) => bracketRounds(seedsOf(kind, cfg).length);

/** The league week of a bracket round. */
function weekOf(kind: BracketKind, round: number, start: number, cfg: BracketConfig): number {
  return roundWeek(kind, round, start, roundsOf("playoffs", cfg), roundsOf("toilet_bowl", cfg));
}

/** The label for a bracket matchup row; undefined for the regular season. */
export function bracketTag(row: Pick<BracketRow, "bracket" | "bracket_round">, cfg: BracketConfig): BracketTag | undefined {
  if (!row.bracket || row.bracket_round === null) return undefined;
  const rounds = roundsOf(row.bracket, cfg);
  const label = bracketLabel(row.bracket, row.bracket_round, rounds);
  return { kind: row.bracket, round: row.bracket_round, roundName: label.split(" · ")[1], label };
}

const storedScore = (r: BracketRow): MatchupScore => ({ wins: r.team_a_wins, losses: r.team_b_wins, ties: r.ties });

export interface PlayoffsViewInput {
  cfg: BracketConfig;
  /** First playoff week; null = no playoff schedule (rounds show no weeks). */
  start: number | null;
  weeks: WeekRow[];
  today: string;
  /** Every matchup row (bracket rows are picked out). */
  rows: BracketRow[];
  /** Team ids in current standings order: the projection's seeds. */
  order: number[];
  team: (id: number) => FantasyTeamSummary;
  /** Regular-season records. */
  records: Map<number, MatchupScore>;
  mineId: number | null;
  /** Week lines for the weeks that have started (live scores). */
  lines: LinesByWeek;
}

/**
 * The Playoffs view: the real brackets once bracket matchups exist, else a
 * projection seeded from today's standings ("if the season ended today").
 */
export function buildPlayoffsView(input: PlayoffsViewInput): PlayoffsView {
  const { cfg, start, weeks, today, rows, order, team, records, mineId, lines } = input;
  const bracketRows = rows.filter((r) => r.bracket !== null);
  const projected = bracketRows.length === 0;
  const zero = { wins: 0, losses: 0, ties: 0 };
  const entry = (id: number, seed: number): BracketTeam => ({
    ...team(id), seed, record: records.get(id) ?? zero, isMine: id === mineId,
  });
  const weekInfo = (n: number | null) => {
    const w = n === null ? undefined : weeks.find((x) => x.week === n);
    return w ? { week: w.week, startsOn: w.starts_on, endsOn: w.ends_on } : null;
  };

  const tbd = (slot: number): BracketGame => ({
    slot, a: null, b: null, bye: false, score: null, status: "upcoming", winnerId: null, advancesId: null,
  });
  const projectedGame = (p: Pairing, slot: number): BracketGame => ({
    slot, a: entry(p.a.teamId, p.a.seed), b: p.b ? entry(p.b.teamId, p.b.seed) : null, bye: p.b === null,
    score: null, status: "upcoming", winnerId: null, advancesId: p.b === null ? p.a.teamId : null,
  });
  const realGame = (kind: BracketKind, r: BracketRow): BracketGame => {
    const a = entry(r.team_a_id, r.seed_a!);
    if (r.team_b_id === null) {
      return { slot: r.bracket_slot!, a, b: null, bye: true, score: null, status: "final", winnerId: a.id, advancesId: a.id };
    }
    const b = entry(r.team_b_id, r.seed_b!);
    const w = weeks.find((x) => x.week === r.week);
    const status: BracketGame["status"] =
      r.status === "final" || (w && today > w.ends_on) ? "final" : w && today >= w.starts_on ? "live" : "upcoming";
    const score = r.status === "final" ? storedScore(r) : lines.has(r.week) ? scoreIn(lines, r.week, a.id, b.id) : null;
    let winnerId: number | null = null;
    let advancesId: number | null = null;
    if (status === "final") {
      const g: Played = { a: { teamId: a.id, seed: a.seed }, b: { teamId: b.id, seed: b.seed }, score: score ?? zero };
      winnerId = outcome(g).winner.teamId;
      advancesId = advancing(kind, g).teamId;
    }
    return { slot: r.bracket_slot!, a, b, bye: false, score, status, winnerId, advancesId };
  };

  const build = (kind: BracketKind): Bracket => {
    const seeds = seedsOf(kind, cfg);
    const total = bracketRounds(seeds.length);
    const rounds: BracketRound[] = [];
    for (let round = 1; round <= total; round++) {
      const slots = 2 ** (total - round);
      let games: BracketGame[];
      if (projected) {
        games = round === 1
          ? firstRound(kind, seeds.map((s) => ({ teamId: order[s - 1], seed: s }))).map(projectedGame)
          : Array.from({ length: slots }, (_, i) => tbd(i));
      } else {
        const inRound = bracketRows.filter((r) => r.bracket === kind && r.bracket_round === round);
        games = Array.from({ length: slots }, (_, i) => {
          const r = inRound.find((x) => x.bracket_slot === i);
          return r ? realGame(kind, r) : tbd(i);
        });
      }
      const name = kind === "playoffs" ? roundName(round, total) : round === total ? "Final" : `Round ${round}`;
      rounds.push({ round, name, week: weekInfo(start === null ? null : weekOf(kind, round, start, cfg)), games });
    }
    const last = rounds[rounds.length - 1]?.games[0];
    let result: BracketTeam | null = null;
    if (last && last.status === "final" && last.a && (last.b || last.bye)) {
      const id = kind === "playoffs" ? last.winnerId : last.advancesId;
      result = [last.a, last.b].find((t) => t?.id === id) ?? null;
    }
    return { kind, teams: seeds.length, rounds, result };
  };

  return {
    projected,
    playoffs: build("playoffs"),
    toiletBowl: cfg.toiletBowlTeams > 0 && seedsOf("toilet_bowl", cfg).length >= 2 ? build("toilet_bowl") : null,
  };
}

interface LeagueRow {
  id: number;
  team_count: number;
  playoff_teams: number;
  playoff_start_week: number | null;
  toilet_bowl: boolean;
  toilet_bowl_teams: number;
  today: string;
}

export const configOf = (l: Pick<LeagueRow, "team_count" | "playoff_teams" | "toilet_bowl" | "toilet_bowl_teams">): BracketConfig => ({
  teamCount: l.team_count, playoffTeams: l.playoff_teams, toiletBowlTeams: l.toilet_bowl ? l.toilet_bowl_teams : 0,
});

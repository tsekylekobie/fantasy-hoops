// Playoffs and the toilet bowl as real rounds in `matchups`, and the League
// page's Playoffs view (the bracket rules are in src/lib/playoffs/bracket.ts).
//
// syncPlayoffs is the one function that creates bracket matchups. It is
// idempotent and safe to run any time (the worker's playoffs task runs it every
// 15 minutes and just after midnight; `npm run playoffs` and
// POST /api/dev/playoffs run it by hand):
// - once the last regular-season week has ended, it seeds both brackets from
//   the final regular-season standings and creates round 1 of each (byes are
//   rows with team_b_id NULL, final from the start);
// - once a round's week has ended, it stores that round's scores on its rows
//   (status 'final', category wins) and creates the next round from them.
// Stored results are what later rounds and the bracket use, so a stat
// correction after a round has been decided doesn't reshuffle the bracket.
// Category scoring is the regular season's (queries/matchups.ts).
import type { Pool } from "pg";
import {
  advancing, bracketLabel, bracketRounds, bracketSeeds, firstRound, nextRound, outcome, roundName, roundWeek,
  standingsOrder, type Pairing, type Played,
} from "../playoffs/bracket";
import type {
  Bracket, BracketGame, BracketKind, BracketRound, BracketTag, BracketTeam, FantasyTeamSummary, MatchupScore, PlayoffsView,
} from "../types";
import {
  WEEKS_SQL, isRegularWeek, playoffStart, recordsFrom, scoreIn, startedWeekLines,
  type LinesByWeek, type PairRow, type WeekRow,
} from "./standings";

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

const KINDS: BracketKind[] = ["playoffs", "toilet_bowl"];

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

export interface PlayoffsSync {
  /** What happened, one line each; empty when there was nothing to do. */
  log: string[];
  /** Why nothing could happen yet ("regular season not over"), else null. */
  waiting: string | null;
}

/**
 * Creates the season league's playoff and toilet bowl matchups that are due
 * as of `today` (yyyy-mm-dd; default the league's today), and records the
 * results of bracket weeks that have ended. Idempotent.
 */
export async function syncPlayoffs(db: Pool, season: number, opts: { today?: string } = {}): Promise<PlayoffsSync> {
  const { rows: [league] } = await db.query<LeagueRow>(
    `SELECT l.id::int, (SELECT count(*)::int FROM fantasy_teams ft WHERE ft.league_id = l.id) AS team_count,
            l.playoff_teams, l.playoff_start_week, l.toilet_bowl, l.toilet_bowl_teams,
            to_char((now() AT TIME ZONE l.time_zone)::date, 'YYYY-MM-DD') AS today
       FROM leagues l WHERE l.season = $1 ORDER BY l.id LIMIT 1`,
    [season],
  );
  if (!league) return { log: [], waiting: "no league" };
  const today = opts.today ?? league.today;
  const cfg = configOf(league);
  const { rows: weeks } = await db.query<WeekRow>(WEEKS_SQL, [league.id]);
  const start = playoffStart(weeks, league.playoff_start_week);
  if (start === null) return { log: [], waiting: "no playoff weeks in the schedule" };
  const regular = weeks.filter((w) => isRegularWeek(w, start));
  const lastRegular = regular[regular.length - 1];
  if (!lastRegular) return { log: [], waiting: "no regular-season weeks" };
  if (today <= lastRegular.ends_on) return { log: [], waiting: `regular season ends ${lastRegular.ends_on}` };

  const log: string[] = [];
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // One run at a time (the worker and a manual run could overlap).
    await client.query(`SELECT 1 FROM leagues WHERE id = $1 FOR UPDATE`, [league.id]);
    const { rows } = await client.query<BracketRow>(MATCHUP_ROWS_SQL, [league.id]);
    const bracketRows = rows.filter((r) => r.bracket !== null);
    const weekById = new Map(weeks.map((w) => [w.week, w]));
    const ended = (week: number) => {
      const w = weekById.get(week);
      return w !== undefined && today > w.ends_on;
    };
    const linesCache = new Map<number, LinesByWeek>();
    const linesFor = async (week: number): Promise<LinesByWeek> => {
      if (!linesCache.has(week)) linesCache.set(week, await startedWeekLines(db, league.id, [weekById.get(week)!], today));
      return linesCache.get(week)!;
    };

    // Inserted rows join `bracketRows` too, so one run plays on through every week that has ended.
    const insert = async (kind: BracketKind, round: number, week: number, pairs: Pairing[]) => {
      for (const [slot, p] of pairs.entries()) {
        await client.query(
          `INSERT INTO matchups (league_id, week, team_a_id, team_b_id, bracket, bracket_round, bracket_slot, seed_a, seed_b, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (league_id, bracket, bracket_round, bracket_slot) WHERE bracket IS NOT NULL DO NOTHING`,
          [league.id, week, p.a.teamId, p.b?.teamId ?? null, kind, round, slot, p.a.seed, p.b?.seed ?? null,
            p.b ? "upcoming" : "final"],
        );
        bracketRows.push({
          week, team_a_id: p.a.teamId, team_b_id: p.b?.teamId ?? null, bracket: kind, bracket_round: round,
          bracket_slot: slot, seed_a: p.a.seed, seed_b: p.b?.seed ?? null, status: p.b ? "upcoming" : "final",
          team_a_wins: 0, team_b_wins: 0, ties: 0,
        });
      }
      const label = bracketLabel(kind, round, roundsOf(kind, cfg));
      log.push(`${label} (week ${week}): ${pairs.map((p) => (p.b ? `${p.a.seed}v${p.b.seed}` : `${p.a.seed} bye`)).join(", ")}`);
    };

    // Round 1 of each bracket, seeded from the final regular-season standings.
    const kinds = KINDS.filter((k) => roundsOf(k, cfg) > 0 && (k === "playoffs" || cfg.toiletBowlTeams > 0));
    const needsSeeds = kinds.some((k) => !bracketRows.some((r) => r.bracket === k && r.bracket_round === 1));
    let order: number[] = [];
    if (needsSeeds) {
      const { rows: teams } = await client.query<{ id: number; name: string }>(
        `SELECT id::int, name FROM fantasy_teams WHERE league_id = $1`,
        [league.id],
      );
      const lines = await startedWeekLines(db, league.id, regular, today);
      const records = recordsFrom(teams.map((t) => t.id), rows.filter((r) => r.bracket === null), lines);
      order = standingsOrder(teams.map((t) => ({ ...t, record: records.get(t.id)! }))).map((t) => t.id);
    }

    for (const kind of kinds) {
      const total = roundsOf(kind, cfg);
      const inRound = (n: number) => bracketRows
        .filter((r) => r.bracket === kind && r.bracket_round === n)
        .sort((x, y) => x.bracket_slot! - y.bracket_slot!);

      if (inRound(1).length === 0) {
        const seeds = seedsOf(kind, cfg).map((s) => ({ teamId: order[s - 1], seed: s }));
        const week = weekOf(kind, 1, start, cfg);
        if (!weekById.has(week)) { log.push(`${kind}: week ${week} isn't in the schedule`); continue; }
        await insert(kind, 1, week, firstRound(kind, seeds));
      }

      for (let round = 1; round <= total; round++) {
        const games = inRound(round);
        if (games.length === 0) break;
        const week = games[0].week;
        if (!ended(week)) break;
        // Record the round's results once, and play on from the stored ones.
        const lines = await linesFor(week);
        const played: Played[] = [];
        for (const g of games) {
          const score = g.team_b_id === null ? { wins: 0, losses: 0, ties: 0 }
            : g.status === "final" ? storedScore(g) : scoreIn(lines, week, g.team_a_id, g.team_b_id);
          if (g.status !== "final") {
            await client.query(
              `UPDATE matchups SET status = 'final', team_a_wins = $5, team_b_wins = $6, ties = $7
                WHERE league_id = $1 AND bracket = $2 AND bracket_round = $3 AND bracket_slot = $4`,
              [league.id, kind, round, g.bracket_slot, score.wins, score.losses, score.ties],
            );
            log.push(`${bracketLabel(kind, round, total)} final: ${g.seed_a} ${score.wins}–${score.losses}–${score.ties} ${g.seed_b}`);
          }
          played.push({
            a: { teamId: g.team_a_id, seed: g.seed_a! },
            b: g.team_b_id === null ? null : { teamId: g.team_b_id, seed: g.seed_b! },
            score,
          });
        }
        if (round === total || inRound(round + 1).length > 0) continue;
        const next = weekOf(kind, round + 1, start, cfg);
        if (!weekById.has(next)) { log.push(`${kind}: week ${next} isn't in the schedule`); break; }
        await insert(kind, round + 1, next, nextRound(kind, played));
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { log, waiting: null };
}

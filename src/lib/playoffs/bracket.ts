// Playoff and toilet bowl brackets: seeding, pairings and who advances. Pure,
// so the League page's projection, the real rounds (queries/playoffs.ts) and
// the tests all share it.
//
// Rules:
// - Seeds are the regular-season standings order (standingsOrder): category
//   win %, then category wins, then team name. Seed 1 is first place.
// - Playoffs: the top `playoffTeams` seeds, single elimination, the winner
//   advances. Round 1 pairs 1v8, 4v5, 3v6, 2v7 (for 8); with fewer teams than
//   a power of two the top seeds get byes.
// - Toilet bowl: the bottom `toiletBowlTeams` seeds, the LOSER advances, and
//   the loser of its final is last place. For 4 teams round 1 is 9v12 and
//   10v11, then the two losers meet. Byes there go to the worst teams (a bye
//   moves you on, which in this bracket is bad news).
// - A tied matchup (equal categories won and lost) goes to the better seed:
//   in the playoffs the better seed advances, in the toilet bowl the worse seed
//   does.
// - The toilet bowl ends in the same week as the playoff final, so with 8 + 4
//   its two rounds are the last two playoff weeks.
// - Teams in neither bracket (only when playoffTeams + toiletBowlTeams is less
//   than the league) are done after the regular season.
import type { BracketKind, MatchupScore } from "../types";

export interface Seeded {
  teamId: number;
  /** Overall seed, 1 = first place. */
  seed: number;
}

export interface Pairing {
  /** Top of the pairing (round 1: the better seed). */
  a: Seeded;
  /** null = bye. */
  b: Seeded | null;
}

export interface Played extends Pairing {
  /** Categories for `a`. */
  score: MatchupScore;
}

/** Rounds in a single-elimination bracket of `teams` (0 for fewer than 2). */
export function bracketRounds(teams: number): number {
  return teams < 2 ? 0 : Math.ceil(Math.log2(teams));
}

/**
 * Bracket positions for `size` (a power of two), top to bottom: [1, 8, 5, 4,
 * 3, 6, 7, 2] for 8. Consecutive pairs play each other, and seeds 1 and 2 can
 * only meet in the final.
 */
export function bracketOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const m = order.length * 2 + 1;
    order = order.flatMap((s, i) => (i % 2 === 0 ? [s, m - s] : [m - s, s]));
  }
  return order;
}

/**
 * Round 1 of a bracket. `seeds` are the bracket's teams, best overall seed
 * first. In the toilet bowl the worst team is the bracket's "top seed" (first
 * to a bye), but each pairing still lists the better overall seed as `a`.
 */
export function firstRound(kind: BracketKind, seeds: Seeded[]): Pairing[] {
  const n = seeds.length;
  if (n < 2) return [];
  const bySeed = kind === "playoffs" ? seeds : [...seeds].reverse();
  const order = bracketOrder(2 ** bracketRounds(n));
  const out: Pairing[] = [];
  for (let i = 0; i < order.length; i += 2) {
    const [x, y] = [bySeed[order[i] - 1] ?? null, bySeed[order[i + 1] - 1] ?? null];
    const present = [x, y].filter((t): t is Seeded => t !== null).sort((p, q) => p.seed - q.seed);
    out.push({ a: present[0], b: present[1] ?? null });
  }
  return out;
}

/** Winner and loser of a played pairing; a tie goes to the better (lower) seed. Byes: a wins. */
export function outcome(g: Played): { winner: Seeded; loser: Seeded | null } {
  if (!g.b) return { winner: g.a, loser: null };
  const margin = g.score.wins - g.score.losses;
  const aWins = margin > 0 || (margin === 0 && g.a.seed < g.b.seed);
  return aWins ? { winner: g.a, loser: g.b } : { winner: g.b, loser: g.a };
}

/** Who moves on from a game: the winner in the playoffs, the loser in the toilet bowl; a bye moves on either way. */
export function advancing(kind: BracketKind, g: Played): Seeded {
  const { winner, loser } = outcome(g);
  return kind === "playoffs" || !loser ? winner : loser;
}

/** The next round from a finished one, in slot order: slots 2k and 2k+1 feed slot k (a from 2k). */
export function nextRound(kind: BracketKind, prev: Played[]): Pairing[] {
  const out: Pairing[] = [];
  for (let k = 0; k * 2 + 1 < prev.length; k++) {
    out.push({ a: advancing(kind, prev[2 * k]), b: advancing(kind, prev[2 * k + 1]) });
  }
  return out;
}

/** "Final", "Semifinal", "Quarterfinal", else "Round N". */
export function roundName(round: number, rounds: number): string {
  const fromEnd = rounds - round;
  return fromEnd === 0 ? "Final" : fromEnd === 1 ? "Semifinal" : fromEnd === 2 ? "Quarterfinal" : `Round ${round}`;
}

/** "Playoffs · Semifinal", "Toilet bowl · Round 1" (its final is "Toilet bowl · Final"). */
export function bracketLabel(kind: BracketKind, round: number, rounds: number): string {
  const name = kind === "playoffs" ? roundName(round, rounds) : round === rounds ? "Final" : `Round ${round}`;
  return `${kind === "playoffs" ? "Playoffs" : "Toilet bowl"} · ${name}`;
}

/**
 * League weeks for each round. Playoffs: playoffStartWeek, then one week per
 * round. The toilet bowl ends with the playoff final, so it starts later when
 * it has fewer rounds.
 */
export function roundWeek(kind: BracketKind, round: number, start: number, playoffRounds: number, toiletRounds: number): number {
  return kind === "playoffs" ? start + round - 1 : start + playoffRounds - toiletRounds + round - 1;
}

/** Which overall seeds play in each bracket for a league of `teamCount`. */
export function bracketSeeds(
  teamCount: number, playoffTeams: number, toiletBowlTeams: number,
): { playoffs: number[]; toiletBowl: number[] } {
  const p = Math.min(playoffTeams, teamCount);
  const t = Math.min(toiletBowlTeams, teamCount - p);
  const range = (from: number, n: number) => Array.from({ length: Math.max(0, n) }, (_, i) => from + i);
  return { playoffs: range(1, p), toiletBowl: range(teamCount - t + 1, t) };
}

export interface StandingsEntry {
  id: number;
  name: string;
  record: MatchupScore;
}

/** (W + T/2) / categories, rounded to three decimals; null before any. */
export function winPct(r: MatchupScore): number | null {
  const n = r.wins + r.losses + r.ties;
  return n > 0 ? Math.round(((r.wins + r.ties / 2) / n) * 1000) / 1000 : null;
}

/** Standings order (and so seeds): category win %, then category wins, then name. */
export function standingsOrder<T extends StandingsEntry>(teams: T[]): T[] {
  return [...teams].sort(
    (x, y) =>
      (winPct(y.record) ?? 0) - (winPct(x.record) ?? 0) || y.record.wins - x.record.wins || x.name.localeCompare(y.name),
  );
}

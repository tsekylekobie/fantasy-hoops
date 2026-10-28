// The trade analyzer: what a trade does to both teams. Pure (no DB) so the
// builder can re-price every pick on the client, and so it can be unit tested.
//
// - A team's line is the per-game sum of its active players (not on IL/IL+):
//   each player's average in the chosen window, added up. FG%/FT% come from
//   the summed makes and attempts, never an average of percentages.
// - After the trade: the active players it keeps, minus its drops, plus every
//   arrival (arrivals land on the bench, so they count as active, as in
//   queries/trades.ts checkRosters).
// - Drops: a team over the active limit after the trade must drop that many.
//   Picked drops count first; the rest are assumed to be its lowest-value
//   players (by the chosen window and weights) and marked as such.
// - Ranks: 1 = best of the league's teams (fewest TO), ties sharing a place,
//   like queries/rankings.ts categoryRanks. The other teams don't change.
// - Value: the sum of the players' 9CAT values over the roster, IL included,
//   so a move to or from IL isn't a value change.
// - Lineup: the best lineup the active players can fill, by value, with the
//   league's starting slots; empty slots are positional holes.
import { eligibleSlots } from "../lineup/rules";
import {
  CATEGORIES,
  type Category,
  type LineupSlot,
  type PerGameLine,
  type TradeAnalysisPlayer,
  type TradeAnalysisResponse,
  type TradeWindow,
} from "../types";

export type WeightSet = "mine" | "default";

export interface TradeSideInput {
  teamId: number;
  /** Player ids this team gives up. */
  out: number[];
  /** Its picked drops (its own players, not ones it gives up). */
  drops: number[];
}

export interface CategoryChange {
  key: Category;
  /** Null when there are no attempts (FG%/FT%). */
  before: number | null;
  after: number | null;
  /** Better for this team: higher, or fewer TO. Null when unchanged. */
  better: boolean | null;
  rankBefore: number;
  rankAfter: number;
}

export interface SideAnalysis {
  teamId: number;
  categories: CategoryChange[];
  valueBefore: number;
  valueAfter: number;
  out: TradeAnalysisPlayer[];
  incoming: TradeAnalysisPlayer[];
  /** Drops counted in "after": picked ones, then assumed ones (lowest value). */
  drops: { player: TradeAnalysisPlayer; assumed: boolean }[];
  /** Players it must drop to fit the active limit (picked or not). */
  mustDrop: number;
  activeBefore: number;
  /** Active players after the trade, before any drops. */
  activeAfter: number;
  /** The best lineup after the trade; player null = nobody eligible. */
  lineup: { slot: LineupSlot; player: TradeAnalysisPlayer | null }[];
  /** Empty starting slots before the trade (holes it already had). */
  emptyBefore: number;
  /** Players eligible at each position group (G, F, C), before and after, and the slots that need them. */
  positions: { group: "G" | "F" | "C"; before: number; after: number; needed: number }[];
}

const KEYS = ["fgm", "fga", "ftm", "fta", "fg3m", "pts", "reb", "ast", "stl", "blk", "tov"] as const;
const IL: LineupSlot[] = ["IL", "IL+"];

export const emptyPerGame = (): PerGameLine => ({ fgm: 0, fga: 0, ftm: 0, fta: 0, fg3m: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0 });

export function addPerGame(a: PerGameLine, b: PerGameLine): PerGameLine {
  const out = emptyPerGame();
  for (const k of KEYS) out[k] = a[k] + b[k];
  return out;
}

/** The nine category values of a team line. */
export function categoryValues(t: PerGameLine): Record<Category, number | null> {
  return {
    fgPct: t.fga > 0 ? t.fgm / t.fga : null,
    ftPct: t.fta > 0 ? t.ftm / t.fta : null,
    fg3m: t.fg3m, pts: t.pts, reb: t.reb, ast: t.ast, stl: t.stl, blk: t.blk, tov: t.tov,
  };
}

const isActive = (p: TradeAnalysisPlayer) => !IL.includes(p.slot);

export function teamLine(players: TradeAnalysisPlayer[], window: TradeWindow): PerGameLine {
  return players.reduce((t, p) => (p[window] ? addPerGame(t, p[window]!.perGame) : t), emptyPerGame());
}

export function playerValue(p: TradeAnalysisPlayer, window: TradeWindow, weights: WeightSet): number {
  const l = p[window];
  return l ? (weights === "mine" ? l.value : l.defaultValue) : 0;
}

/** 1 = best; ties share a place. A line with no attempts sits below any percentage. */
function rank(lines: Record<Category, number | null>[], i: number, key: Category): number {
  const v = (j: number) => lines[j][key] ?? -1;
  const mine = v(i);
  return 1 + lines.filter((_, j) => j !== i && (key === "tov" ? v(j) < mine : v(j) > mine)).length;
}

/** Players eligible per position group (BALLDONTLIE positions: G, F, C, or combos like F-C). */
function inGroup(p: TradeAnalysisPlayer, group: "G" | "F" | "C"): boolean {
  return (p.position ?? "").split("-").includes(group);
}

/**
 * The best lineup `players` can fill: each slot gets a player (or nobody),
 * favoring higher value, filling as many slots as possible (bipartite matching,
 * players tried best first).
 */
export function bestLineup(
  players: TradeAnalysisPlayer[], slots: { slot: LineupSlot; count: number }[], value: (p: TradeAnalysisPlayer) => number,
): { slot: LineupSlot; player: TradeAnalysisPlayer | null }[] {
  const open = slots.flatMap((s) => Array.from({ length: s.count }, () => s.slot));
  const ranked = [...players].sort((a, b) => value(b) - value(a) || a.id - b.id);
  const fits = ranked.map((p) => new Set(eligibleSlots(p.position, [])));
  const match: number[] = open.map(() => -1);
  const place = (pi: number, seen: Set<number>): boolean => {
    for (let s = 0; s < open.length; s++) {
      if (seen.has(s) || !fits[pi].has(open[s])) continue;
      seen.add(s);
      if (match[s] < 0 || place(match[s], seen)) {
        match[s] = pi;
        return true;
      }
    }
    return false;
  };
  ranked.forEach((_, pi) => place(pi, new Set()));
  return open.map((slot, s) => ({ slot, player: match[s] >= 0 ? ranked[match[s]] : null }));
}

/**
 * Both sides of a trade between data.teams. `sides` names each team's
 * outgoing players and picked drops; a side's arrivals are the other side's out.
 */
export function analyzeTrade(
  data: TradeAnalysisResponse, sides: [TradeSideInput, TradeSideInput], window: TradeWindow, weights: WeightSet,
): [SideAnalysis, SideAnalysis] {
  const value = (p: TradeAnalysisPlayer) => playerValue(p, window, weights);
  const rosters = sides.map((s) => data.teams.find((t) => t.id === s.teamId)?.players ?? []);

  const shaped = sides.map((side, i) => {
    const roster = rosters[i];
    const out = roster.filter((p) => side.out.includes(p.id));
    const incoming = rosters[1 - i].filter((p) => sides[1 - i].out.includes(p.id));
    const keep = roster.filter((p) => !side.out.includes(p.id));
    const activeBefore = roster.filter(isActive).length;
    const activeAfter = keep.filter(isActive).length + incoming.length;
    const mustDrop = Math.max(0, activeAfter - data.activeLimit);
    const droppable = keep.filter(isActive);
    const picked = side.drops
      .map((id) => droppable.find((p) => p.id === id))
      .filter((p): p is TradeAnalysisPlayer => p !== undefined)
      .slice(0, mustDrop);
    const assumed = droppable
      .filter((p) => !picked.includes(p))
      .sort((a, b) => value(a) - value(b) || a.id - b.id)
      .slice(0, mustDrop - picked.length);
    const drops = [...picked.map((player) => ({ player, assumed: false })), ...assumed.map((player) => ({ player, assumed: true }))];
    const dropIds = new Set(drops.map((d) => d.player.id));
    const after = [...keep.filter((p) => !dropIds.has(p.id)), ...incoming];
    return { roster, out, incoming, drops, mustDrop, activeBefore, activeAfter, after };
  });

  // League lines before and after; the two teams' come from their rosters.
  const others = data.league.filter((t) => !sides.some((s) => s.teamId === t.teamId)).map((t) => categoryValues(t[window]));
  const before = [
    ...shaped.map((s) => categoryValues(teamLine(s.roster.filter(isActive), window))),
    ...others,
  ];
  const after = [...shaped.map((s) => categoryValues(teamLine(s.after.filter(isActive), window))), ...others];

  const groups = (["G", "F", "C"] as const).map((group) => {
    const needed = data.slots
      .filter((s) => (group === "G" ? ["PG", "SG", "G"] : group === "F" ? ["SF", "PF", "F"] : ["C"]).includes(s.slot))
      .reduce((n, s) => n + s.count, 0);
    return { group, needed };
  });

  const out = shaped.map((s, i): SideAnalysis => {
    const activeNow = s.roster.filter(isActive);
    const activeLater = s.after.filter(isActive);
    return {
      teamId: sides[i].teamId,
      categories: CATEGORIES.map((key) => {
        const b = before[i][key], a = after[i][key];
        const changed = a !== null && b !== null && Math.abs(a - b) > 1e-9;
        return {
          key, before: b, after: a,
          better: changed ? (key === "tov" ? a! < b! : a! > b!) : null,
          rankBefore: rank(before, i, key),
          rankAfter: rank(after, i, key),
        };
      }),
      valueBefore: s.roster.reduce((n, p) => n + value(p), 0),
      valueAfter: s.after.reduce((n, p) => n + value(p), 0),
      out: s.out,
      incoming: s.incoming,
      drops: s.drops,
      mustDrop: s.mustDrop,
      activeBefore: s.activeBefore,
      activeAfter: s.activeAfter,
      lineup: bestLineup(activeLater, data.slots, value),
      emptyBefore: bestLineup(activeNow, data.slots, value).filter((x) => !x.player).length,
      positions: groups.map(({ group, needed }) => ({
        group, needed,
        before: activeNow.filter((p) => inGroup(p, group)).length,
        after: activeLater.filter((p) => inGroup(p, group)).length,
      })),
    };
  });
  return [out[0], out[1]];
}

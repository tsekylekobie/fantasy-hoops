// 9CAT player valuation. Pure functions (no DB) so they can be unit tested.
//
// Method (z-scores against the players worth rostering; reproduces Basketball
// Monster's per-game values to the hundredth when all weights are 1):
// 1. Per-game averages for every player with at least one game played.
// 2. A reference pool of POOL_SIZE players = 12 teams x 13 roster spots, i.e.
//    roughly the players rostered in our league. Eligible: GP >= 25% of the
//    most games anyone has played this season (at least 1). The pool starts as
//    the top POOL_SIZE eligible players by minutes per game; then, POOL_PASSES
//    times, everyone is valued against it (plain 9CAT, all weights 1) and the
//    pool becomes the top POOL_SIZE eligible players by that value.
// 3. Mean and (sample) stdev of each category over the pool.
// 4. z = (x - mean) / stdev for 3PM, PTS, REB, AST, STL, BLK, and the negated
//    z for TO. FG% and FT% use impact per game: (makes - poolPct * attempts) / GP,
//    where poolPct is the pool's summed makes / summed attempts, so a 60% shooter
//    on 2 attempts matters less than a 52% shooter on 20. The impacts are then
//    z-scored over the pool like the counting stats.
// 5. Value = the weighted average of the nine z-scores: sum(weight * z) / sum(weight),
//    with the caller's punt weights (all 1 by default), so punting a category
//    doesn't change the scale. 0 is the pool's average player. Players outside
//    the pool are scored with the pool's means and stdevs. A category with zero
//    spread has z = 0.
import type { Category, CategoryWeights, RankTier } from "../types";

export const POOL_SIZE = 156;
export const MIN_GP_FRACTION = 0.25;
/** Times the pool is re-picked by value (step 2). 3 matches Basketball Monster best. */
export const POOL_PASSES = 3;

export interface SeasonTotals {
  playerId: number;
  gp: number;
  min: number;
  fgm: number;
  fga: number;
  ftm: number;
  fta: number;
  fg3m: number;
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
}

export interface Valuation {
  value: number;
  /** 1-based rank by value among all players passed in. */
  rank: number;
  /**
   * Where each category z (and the weighted value) falls among the pool's
   * (step 2), so the shading says how he compares with a rostered player.
   * No FG%/FT% tier without attempts.
   */
  tiers: Partial<Record<Category | "value", RankTier>>;
  /** Each category's z-score against the pool (unweighted; FG%/FT% are the impact z-scores, TO is negated). */
  z: Record<Category, number>;
  /** Total FG/FT impact over all games: makes - poolPct * attempts. */
  impact: { fgPct: number; ftPct: number };
}

/** Tier from a place between 0 (best) and 1 (worst). */
export function tierOf(place: number): RankTier {
  if (place <= 0.1) return "top10";
  if (place <= 0.25) return "top25";
  if (place <= 0.4) return "top40";
  if (place >= 0.9) return "bottom10";
  if (place >= 0.75) return "bottom25";
  return "mid";
}

/** `x`'s place in `sortedDesc` (0 best, 1 worst); a tie sits in the middle of it. */
export function placeIn(sortedDesc: number[], x: number): number {
  const n = sortedDesc.length;
  if (n === 0) return 0.5;
  let above = 0;
  let equal = 0;
  for (const v of sortedDesc) {
    if (v > x) above++;
    else if (v === x) equal++;
    else break;
  }
  return (above + equal / 2) / n;
}

const COUNTING = ["fg3m", "pts", "reb", "ast", "stl", "blk", "tov"] as const;
type Cat = (typeof COUNTING)[number] | "fgImpact" | "ftImpact";
const CATS: Cat[] = ["fgImpact", "ftImpact", ...COUNTING];
const CATEGORY: Record<Cat, Category> = {
  fgImpact: "fgPct", ftImpact: "ftPct", fg3m: "fg3m", pts: "pts", reb: "reb", ast: "ast", stl: "stl", blk: "blk", tov: "tov",
};

/** Every category counted fully: plain 9CAT value. */
export const EQUAL_WEIGHTS: CategoryWeights = {
  fgPct: 1, ftPct: 1, fg3m: 1, pts: 1, reb: 1, ast: 1, stl: 1, blk: 1, tov: 1,
};

function meanSd(xs: number[]): { mean: number; sd: number } {
  if (xs.length === 0) return { mean: 0, sd: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (xs.length === 1) return { mean, sd: 0 };
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return { mean, sd: Math.sqrt(variance) };
}

const mpg = (p: SeasonTotals) => p.min / p.gp;

/** A pool's league FG%/FT% and each category's mean and stdev; `z` scores any player against them. */
function poolScorer(pool: SeasonTotals[]) {
  const sum = (k: keyof SeasonTotals) => pool.reduce((a, p) => a + p[k], 0);
  const fgPct = sum("fga") > 0 ? sum("fgm") / sum("fga") : 0;
  const ftPct = sum("fta") > 0 ? sum("ftm") / sum("fta") : 0;
  const perGame = (p: SeasonTotals): Record<Cat, number> => {
    const out = {
      fgImpact: (p.fgm - fgPct * p.fga) / p.gp,
      ftImpact: (p.ftm - ftPct * p.fta) / p.gp,
    } as Record<Cat, number>;
    for (const k of COUNTING) out[k] = p[k] / p.gp;
    return out;
  };
  const lines = pool.map(perGame);
  const stats = Object.fromEntries(CATS.map((c) => [c, meanSd(lines.map((l) => l[c]))])) as Record<Cat, { mean: number; sd: number }>;
  const score = (p: SeasonTotals): Record<Cat, number> => {
    const line = perGame(p);
    const z = {} as Record<Cat, number>;
    for (const c of CATS) {
      const { mean, sd } = stats[c];
      z[c] = sd === 0 ? 0 : ((line[c] - mean) / sd) * (c === "tov" ? -1 : 1);
    }
    return z;
  };
  return Object.assign(score, { fgPct, ftPct });
}

/** sum(weight * z) / sum(weight); 0 when every weight is 0. */
function weightedValue(z: Record<Cat, number>, weights: CategoryWeights): number {
  let num = 0;
  let den = 0;
  for (const c of CATS) {
    const w = weights[CATEGORY[c]];
    num += w * z[c];
    den += w;
  }
  return den > 0 ? num / den : 0;
}

/** z-scores keyed by the public category names. */
function byCategory(zs: Record<Cat, number>): Record<Category, number> {
  const out = {} as Record<Category, number>;
  for (const c of CATS) out[CATEGORY[c]] = zs[c];
  return out;
}

/** Best first by value, then minutes per game, then id. */
function byValue(scored: { p: SeasonTotals; value: number }[]) {
  return scored.sort((a, b) => b.value - a.value || mpg(b.p) - mpg(a.p) || a.p.playerId - b.p.playerId);
}

/** The reference pool (step 2). Doesn't depend on punt weights. */
export function selectPool(players: SeasonTotals[]): SeasonTotals[] {
  const played = players.filter((p) => p.gp > 0);
  const maxGp = played.reduce((m, p) => Math.max(m, p.gp), 0);
  const minGp = Math.max(1, Math.ceil(maxGp * MIN_GP_FRACTION));
  const eligible = played.filter((p) => p.gp >= minGp);
  let pool = [...eligible].sort((a, b) => mpg(b) - mpg(a) || a.playerId - b.playerId).slice(0, POOL_SIZE);
  for (let pass = 0; pass < POOL_PASSES; pass++) {
    const z = poolScorer(pool);
    pool = byValue(eligible.map((p) => ({ p, value: weightedValue(z(p), EQUAL_WEIGHTS) })))
      .slice(0, POOL_SIZE)
      .map((s) => s.p);
  }
  return pool;
}

/** Returns a value and rank for every player with gp > 0. The pool and its stats don't depend on the weights. */
export function valuePlayers(players: SeasonTotals[], weights: CategoryWeights = EQUAL_WEIGHTS): Map<number, Valuation> {
  const played = players.filter((p) => p.gp > 0);
  const pool = selectPool(played);
  const z = poolScorer(pool);
  const zs = new Map(played.map((p) => [p.playerId, z(p)]));
  const scored = byValue(played.map((p) => ({ p, value: weightedValue(zs.get(p.playerId)!, weights) })));

  // Each category's (and the value's) pool distribution, best first.
  const desc = (xs: number[]) => xs.sort((a, b) => b - a);
  const poolZ = Object.fromEntries(CATS.map((c) => [c, desc(pool.map((p) => zs.get(p.playerId)![c]))])) as Record<Cat, number[]>;
  const poolValues = desc(pool.map((p) => weightedValue(zs.get(p.playerId)!, weights)));

  const out = new Map<number, Valuation>();
  scored.forEach((s, i) => {
    const pz = zs.get(s.p.playerId)!;
    const tiers: Valuation["tiers"] = { value: tierOf(placeIn(poolValues, s.value)) };
    for (const c of CATS) {
      if ((c === "fgImpact" && s.p.fga === 0) || (c === "ftImpact" && s.p.fta === 0)) continue;
      tiers[CATEGORY[c]] = tierOf(placeIn(poolZ[c], pz[c]));
    }
    out.set(s.p.playerId, {
      value: s.value, rank: i + 1, tiers, z: byCategory(pz),
      impact: { fgPct: s.p.fgm - z.fgPct * s.p.fga, ftPct: s.p.ftm - z.ftPct * s.p.fta },
    });
  });
  return out;
}

/** One game's z-scores (by category) and weighted value. */
export interface GameScore {
  z: Record<Category, number>;
  value: number;
}

/**
 * Scores single-game lines against the season's pool, as if each were a
 * one-game average: the same means, stdevs and league FG%/FT% as valuePlayers,
 * so a game's value is on the Players page's per-game scale. Pass each line
 * with gp = 1.
 */
export function gameScorer(season: SeasonTotals[], weights: CategoryWeights = EQUAL_WEIGHTS): (line: SeasonTotals) => GameScore {
  const z = poolScorer(selectPool(season.filter((p) => p.gp > 0)));
  return (line) => {
    const zs = z({ ...line, gp: 1 });
    return { z: byCategory(zs), value: weightedValue(zs, weights) };
  };
}

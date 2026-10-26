// 9CAT player valuation. Pure functions (no DB) so they can be unit tested.
//
// Method (standard z-score approach):
// 1. Per-game averages for every player with at least one game played.
// 2. A reference pool: players with GP >= minGp (25% of the most games anyone
//    has played this season, at least 1), then the top POOL_SIZE of those by
//    minutes per game. 156 = 12 teams x 13 roster spots, i.e. roughly the
//    players who are rostered in our league. Early in the season everyone
//    with a game qualifies and the pool is just the top 156 by MPG.
// 3. Mean and (population) stdev of each category over the pool.
// 4. z = (x - mean) / stdev for 3PM, PTS, REB, AST, STL, BLK, and the negated
//    z for TO. FG% and FT% use impact per game: (makes - poolPct * attempts) / GP,
//    where poolPct is the pool's summed makes / summed attempts, so a 60% shooter
//    on 2 attempts matters less than a 52% shooter on 20. The impacts are then
//    z-scored over the pool like the counting stats.
// 5. Value = sum of the nine z-scores, each times its category weight (all 1
//    unless the caller passes punt weights). Players outside the pool are scored
//    with the pool's means and stdevs. A category with zero spread contributes 0.
import type { Category, CategoryWeights } from "../types";

export const POOL_SIZE = 156;
export const MIN_GP_FRACTION = 0.25;

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
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return { mean, sd: Math.sqrt(variance) };
}

export function selectPool(players: SeasonTotals[]): SeasonTotals[] {
  const played = players.filter((p) => p.gp > 0);
  const maxGp = played.reduce((m, p) => Math.max(m, p.gp), 0);
  const minGp = Math.max(1, Math.ceil(maxGp * MIN_GP_FRACTION));
  return played
    .filter((p) => p.gp >= minGp)
    .sort((a, b) => b.min / b.gp - a.min / a.gp || a.playerId - b.playerId)
    .slice(0, POOL_SIZE);
}

/** Returns a value and rank for every player with gp > 0. The pool and its stats don't depend on the weights. */
export function valuePlayers(players: SeasonTotals[], weights: CategoryWeights = EQUAL_WEIGHTS): Map<number, Valuation> {
  const played = players.filter((p) => p.gp > 0);
  const pool = selectPool(played);

  const sum = (xs: SeasonTotals[], k: keyof SeasonTotals) => xs.reduce((a, p) => a + p[k], 0);
  const poolFga = sum(pool, "fga");
  const poolFta = sum(pool, "fta");
  const fgPct = poolFga > 0 ? sum(pool, "fgm") / poolFga : 0;
  const ftPct = poolFta > 0 ? sum(pool, "ftm") / poolFta : 0;

  const perGame = (p: SeasonTotals): Record<Cat, number> => {
    const out = {
      fgImpact: (p.fgm - fgPct * p.fga) / p.gp,
      ftImpact: (p.ftm - ftPct * p.fta) / p.gp,
    } as Record<Cat, number>;
    for (const k of COUNTING) out[k] = p[k] / p.gp;
    return out;
  };

  const poolLines = pool.map(perGame);
  const stats = Object.fromEntries(
    CATS.map((c) => [c, meanSd(poolLines.map((l) => l[c]))]),
  ) as Record<Cat, { mean: number; sd: number }>;

  const scored = played.map((p) => {
    const line = perGame(p);
    let value = 0;
    for (const c of CATS) {
      const { mean, sd } = stats[c];
      const w = weights[CATEGORY[c]];
      if (sd === 0 || w === 0) continue;
      const z = (line[c] - mean) / sd;
      value += w * (c === "tov" ? -z : z);
    }
    return { p, value };
  });

  scored.sort(
    (a, b) => b.value - a.value || b.p.min / b.p.gp - a.p.min / a.p.gp || a.p.playerId - b.p.playerId,
  );
  const out = new Map<number, Valuation>();
  scored.forEach((s, i) => out.set(s.p.playerId, { value: s.value, rank: i + 1 }));
  return out;
}

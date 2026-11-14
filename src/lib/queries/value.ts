// Player valuation: Josh Lloyd's DURANT H2H (Dynamic Unbiased Rankings Applying Normalised Transformations,
// https://joshlloydfantasy.com/research/durant-fantasy-basketball/). Pure functions (no DB) so they can be unit tested.
//
// 1. Per-game averages for every player with at least one game played.
// 2. A reference pool of POOL_SIZE players = 12 teams x 13 roster spots, i.e.
//    roughly the players rostered in our league. Eligible: GP >= 25% of the
//    most games anyone has played this season (at least 1). The pool starts as
//    the top POOL_SIZE eligible players by minutes per game; then, POOL_PASSES
//    times, everyone is valued against it (step 5, no punts) and the pool
//    becomes the top POOL_SIZE eligible players by that value.
// 3. Each category's per-game number, higher is better: 3PM, PTS, REB, AST, STL, BLK as they are, TO negated,
//    FG% and FT% as impact per game: (makes - poolPct * attempts) / GP, where poolPct is the pool's summed makes /
//    summed attempts, so a 60% shooter on 2 attempts matters less than a 52% shooter on 20.
// 4. DURANT score per category: a Yeo–Johnson power transform fitted to the pool (lambda by maximum likelihood),
//    then standardized over the pool (yeoJohnson.ts, scikit-learn's PowerTransformer). The transform pulls in long
//    tails (one huge blocks number) before the categories are compared; a category with no spread scores 0.
// 5. Value = DURANT H2H: each category's score times its weight, DURANT_H2H_WEIGHTS (PTS 1, REB 0.94, AST 0.75,
//    the rest 0.6; TO excluded), with the caller's punts (weight 0) left out. Minus 1:
//    the player's worst weighted contribution among the counted categories is dropped (7 of the 8 by default).
//    The rest are summed and divided by the sum of every counted category's weight, so punting doesn't change
//    the scale. 0 is about the pool's average player. Players outside the pool are scored with the
//    pool's transforms.
// 6. Totals (the Players page's Totals mode): the same, over season totals
//    instead of per-game averages (FG%/FT%: total impact, makes - poolPct *
//    attempts), fitted over the same pool's totals. Fewer games means a lower value.
// `z` and the category tiers stay plain z-scores against the pool (the tiers are places, which the transform
// doesn't change); only Value and rank are DURANT.
//
// method "9cat" (the Players page's 9CAT switch) is the valuation before DURANT: the pool is re-picked by plain 9CAT
// value (step 2), and Value is the weighted average of all nine plain z-scores, TO included at its stored weight
// (0.3 by default), punted categories 0 and the rest 1 (nineCatValue). Totals mode z-scores the pool's totals.
import type { Category, CategoryWeights, RankMethod, RankTier } from "../types";
import { fitPowerScaler } from "./yeoJohnson";

export const POOL_SIZE = 156;
export const MIN_GP_FRACTION = 0.25;
/** Times the pool is re-picked by value (step 2). */
export const POOL_PASSES = 3;

/** DURANT H2H's category weights (step 5). Turnovers are excluded. */
export const DURANT_H2H_WEIGHTS: CategoryWeights = {
  fgPct: 0.6, ftPct: 0.6, fg3m: 0.6, pts: 1, reb: 0.94, ast: 0.75, stl: 0.6, blk: 0.6, tov: 0,
};

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
  /** Each category's DURANT score (step 4, unweighted). */
  durant: Record<Category, number>;
  /** The category Minus 1 dropped from `value` (step 5); null when fewer than two count. */
  dropped: Category | null;
  /** Total FG/FT impact over all games: makes - poolPct * attempts. */
  impact: { fgPct: number; ftPct: number };
  /** Value over season totals (step 6): what Totals mode shows. */
  totalValue: number;
  /** 1-based rank by `totalValue` among all players passed in. */
  totalRank: number;
  /**
   * The same, for Totals mode: each category's season total (FG%/FT%: total impact, makes - the pool's
   * percentage * attempts; fewer TO is better) placed among the pool's totals, so fewer games pulls a player
   * down; `value` is `totalValue` among the pool's total values.
   */
  totalTiers: Partial<Record<Category | "value", RankTier>>;
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

/** Each category's number, higher is better (TO negated): `perGame` divides by GP, else season totals (step 6). */
function catLine(p: SeasonTotals, fgPct: number, ftPct: number, perGame: boolean): Record<Cat, number> {
  const d = perGame ? p.gp : 1;
  return {
    fgImpact: (p.fgm - fgPct * p.fga) / d, ftImpact: (p.ftm - ftPct * p.fta) / d,
    fg3m: p.fg3m / d, pts: p.pts / d, reb: p.reb / d, ast: p.ast / d, stl: p.stl / d, blk: p.blk / d, tov: -p.tov / d,
  };
}

type Scorer = (line: Record<Cat, number>) => Record<Cat, number>;

/** Plain z-scores of each category over `lines`. */
function zScorer(lines: Record<Cat, number>[]): Scorer {
  const stats = Object.fromEntries(CATS.map((c) => [c, meanSd(lines.map((l) => l[c]))])) as Record<Cat, { mean: number; sd: number }>;
  return (line) => {
    const z = {} as Record<Cat, number>;
    for (const c of CATS) z[c] = stats[c].sd === 0 ? 0 : (line[c] - stats[c].mean) / stats[c].sd;
    return z;
  };
}

/** DURANT scores (step 4): each category Yeo–Johnson transformed and standardized over `lines`. */
function durantScorer(lines: Record<Cat, number>[]): Scorer {
  const fits = Object.fromEntries(CATS.map((c) => [c, fitPowerScaler(lines.map((l) => l[c]))])) as Record<Cat, ReturnType<typeof fitPowerScaler>>;
  return (line) => {
    const d = {} as Record<Cat, number>;
    for (const c of CATS) d[c] = fits[c](line[c]);
    return d;
  };
}

/** A pool's league FG%/FT% and its per-game z and DURANT scorers. */
function poolScorer(pool: SeasonTotals[]) {
  const sum = (k: keyof SeasonTotals) => pool.reduce((a, p) => a + p[k], 0);
  const fgPct = sum("fga") > 0 ? sum("fgm") / sum("fga") : 0;
  const ftPct = sum("fta") > 0 ? sum("ftm") / sum("fta") : 0;
  const line = (p: SeasonTotals) => catLine(p, fgPct, ftPct, true);
  const lines = pool.map(line);
  const z = zScorer(lines);
  const durant = durantScorer(lines);
  return { fgPct, ftPct, z: (p: SeasonTotals) => z(line(p)), durant: (p: SeasonTotals) => durant(line(p)) };
}

/**
 * DURANT H2H value (step 5) of a player's category scores: DURANT_H2H_WEIGHTS, without the categories `weights`
 * punts (0; any other weight counts fully); Minus 1 drops the worst weighted contribution; the rest over the sum of every counted weight. 0 when nothing counts.
 */
export function durantValue(
  scores: Record<Category, number>, weights: CategoryWeights,
): { value: number; dropped: Category | null } {
  const counted: { c: Category; w: number; contrib: number }[] = [];
  for (const c of Object.keys(DURANT_H2H_WEIGHTS) as Category[]) {
    const w = weights[c] > 0 ? DURANT_H2H_WEIGHTS[c] : 0;
    if (w > 0) counted.push({ c, w, contrib: w * scores[c] });
  }
  const den = counted.reduce((a, x) => a + x.w, 0);
  if (den === 0) return { value: 0, dropped: null };
  let worst: (typeof counted)[number] | null = null;
  if (counted.length > 1) for (const x of counted) if (!worst || x.contrib < worst.contrib) worst = x;
  const num = counted.reduce((a, x) => a + (x === worst ? 0 : x.contrib), 0);
  return { value: num / den, dropped: worst?.c ?? null };
}

/**
 * 9CAT value: the weighted average of the nine plain z-scores. Punted categories (0) are left out, the others count 1,
 * and TO counts at its own stored weight (the old sliders' default, 0.3). 0 when nothing counts.
 */
export function nineCatValue(z: Record<Category, number>, weights: CategoryWeights): number {
  let num = 0;
  let den = 0;
  for (const c of Object.keys(DURANT_H2H_WEIGHTS) as Category[]) {
    const w = c === "tov" ? weights.tov : weights[c] > 0 ? 1 : 0;
    num += w * z[c];
    den += w;
  }
  return den > 0 ? num / den : 0;
}

/** A player's value by `method` from his DURANT scores and plain z-scores. */
function methodValue(
  method: RankMethod, d: Record<Category, number>, z: Record<Category, number>, weights: CategoryWeights,
): { value: number; dropped: Category | null } {
  return method === "durant" ? durantValue(d, weights) : { value: nineCatValue(z, weights), dropped: null };
}

/** Scores keyed by the public category names. */
function byCategory(zs: Record<Cat, number>): Record<Category, number> {
  const out = {} as Record<Category, number>;
  for (const c of CATS) out[CATEGORY[c]] = zs[c];
  return out;
}

/** Best first by value, then minutes per game, then id. */
function byValue(scored: { p: SeasonTotals; value: number }[]) {
  return scored.sort((a, b) => b.value - a.value || mpg(b.p) - mpg(a.p) || a.p.playerId - b.p.playerId);
}

/** The reference pool (step 2), re-picked by `method`'s value. Doesn't depend on punt weights. */
export function selectPool(players: SeasonTotals[], method: RankMethod = "durant"): SeasonTotals[] {
  const played = players.filter((p) => p.gp > 0);
  const maxGp = played.reduce((m, p) => Math.max(m, p.gp), 0);
  const minGp = Math.max(1, Math.ceil(maxGp * MIN_GP_FRACTION));
  const eligible = played.filter((p) => p.gp >= minGp);
  let pool = [...eligible].sort((a, b) => mpg(b) - mpg(a) || a.playerId - b.playerId).slice(0, POOL_SIZE);
  for (let pass = 0; pass < POOL_PASSES; pass++) {
    const s = poolScorer(pool);
    const value = (p: SeasonTotals) => methodValue(method, byCategory(s.durant(p)), byCategory(s.z(p)), EQUAL_WEIGHTS).value;
    pool = byValue(eligible.map((p) => ({ p, value: value(p) })))
      .slice(0, POOL_SIZE)
      .map((x) => x.p);
  }
  return pool;
}

/**
 * Returns a value and rank for every player with gp > 0, by `method` (DURANT H2H by default, or plain 9CAT).
 * The pool and its fits don't depend on the weights.
 */
export function valuePlayers(
  players: SeasonTotals[], weights: CategoryWeights = EQUAL_WEIGHTS, method: RankMethod = "durant",
): Map<number, Valuation> {
  const played = players.filter((p) => p.gp > 0);
  const pool = selectPool(played, method);
  const s = poolScorer(pool);
  const zs = new Map(played.map((p) => [p.playerId, s.z(p)]));
  const ds = new Map(played.map((p) => [p.playerId, s.durant(p)]));
  const valued = new Map(played.map((p) => [p.playerId, methodValue(method, byCategory(ds.get(p.playerId)!), byCategory(zs.get(p.playerId)!), weights)]));
  const scored = byValue(played.map((p) => ({ p, value: valued.get(p.playerId)!.value })));

  // Season totals by category, higher is better (TO negated). FG%/FT% are total impact against the pool's percentage.
  const totals = (p: SeasonTotals) => catLine(p, s.fgPct, s.ftPct, false);

  // Each category's (and the value's) pool distribution, best first.
  const desc = (xs: number[]) => xs.sort((a, b) => b - a);
  const poolZ = Object.fromEntries(CATS.map((c) => [c, desc(pool.map((p) => zs.get(p.playerId)![c]))])) as Record<Cat, number[]>;
  const poolTotals = Object.fromEntries(CATS.map((c) => [c, desc(pool.map((p) => totals(p)[c]))])) as Record<Cat, number[]>;
  const poolValues = desc(pool.map((p) => valued.get(p.playerId)!.value));

  // Step 6: the same over the pool's totals, valued and ranked.
  const totalDurant = method === "durant" ? durantScorer(pool.map(totals)) : null;
  const totalZ = zScorer(pool.map(totals));
  const totalValue = (p: SeasonTotals) => {
    const t = totals(p);
    return methodValue(method, totalDurant ? byCategory(totalDurant(t)) : ({} as Record<Category, number>), byCategory(totalZ(t)), weights).value;
  };
  const totalValues = new Map(played.map((p) => [p.playerId, totalValue(p)]));
  const totalRanks = new Map(
    byValue(played.map((p) => ({ p, value: totalValues.get(p.playerId)! }))).map((x, i) => [x.p.playerId, i + 1]),
  );
  const poolTotalValues = desc(pool.map((p) => totalValues.get(p.playerId)!));

  const out = new Map<number, Valuation>();
  scored.forEach((x, i) => {
    const id = x.p.playerId;
    const pz = zs.get(id)!;
    const pt = totals(x.p);
    const totalValue = totalValues.get(id)!;
    const tiers: Valuation["tiers"] = { value: tierOf(placeIn(poolValues, x.value)) };
    const totalTiers: Valuation["totalTiers"] = { value: tierOf(placeIn(poolTotalValues, totalValue)) };
    for (const c of CATS) {
      if ((c === "fgImpact" && x.p.fga === 0) || (c === "ftImpact" && x.p.fta === 0)) continue;
      tiers[CATEGORY[c]] = tierOf(placeIn(poolZ[c], pz[c]));
      totalTiers[CATEGORY[c]] = tierOf(placeIn(poolTotals[c], pt[c]));
    }
    out.set(id, {
      value: x.value, rank: i + 1, totalValue, totalRank: totalRanks.get(id)!, tiers, totalTiers, z: byCategory(pz),
      durant: byCategory(ds.get(id)!), dropped: valued.get(id)!.dropped,
      impact: { fgPct: pt.fgImpact, ftPct: pt.ftImpact },
    });
  });
  return out;
}

/** One game's z-scores (by category) and DURANT H2H value. */
export interface GameScore {
  z: Record<Category, number>;
  value: number;
}

/**
 * Scores single-game lines against the season's pool, as if each were a
 * one-game average: the same pool, league FG%/FT% and fits as valuePlayers,
 * so a game's value is on the Players page's per-game scale. Pass each line
 * with gp = 1.
 */
export function gameScorer(season: SeasonTotals[], weights: CategoryWeights = EQUAL_WEIGHTS): (line: SeasonTotals) => GameScore {
  const s = poolScorer(selectPool(season.filter((p) => p.gp > 0)));
  return (line) => {
    const one = { ...line, gp: 1 };
    return { z: byCategory(s.z(one)), value: durantValue(byCategory(s.durant(one)), weights).value };
  };
}

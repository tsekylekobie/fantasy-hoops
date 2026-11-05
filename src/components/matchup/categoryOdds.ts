// How each category of a matchup is likely to end: the chance the left side
// wins it by the end of the week, from the week so far and what's left to play.
// The projected totals (MatchupSide.projected) are the expected finish; the
// spread around them grows with the production still to come (projected minus
// actual), so a 40-point lead with 30 games left is a toss-up and the same lead
// on the last night is safe. Pure, so it's tested (categoryOdds.test.ts).
import type { CategoryKey, CategoryLine } from "@/lib/types";
import { CATEGORY_KEYS } from "@/lib/types";

/**
 * Where a category stands for the left side. "won"/"lost"/"tied": nothing left
 * to play. Otherwise by win chance: safe 90%+, ahead 65–90%, tossup 35–65%,
 * behind 10–35%, gone under 10%.
 */
export type OddsTier = "won" | "lost" | "tied" | "safe" | "ahead" | "tossup" | "behind" | "gone";

export interface CategoryOdds {
  /** Chance the left side wins the category, 0–1 (a tie counts half). */
  chance: number;
  tier: OddsTier;
}

type Counting = "fg3m" | "pts" | "reb" | "ast" | "stl" | "blk" | "tov";

/**
 * Variance of one game's stat over its mean, for a team's remaining games
 * (roughly Poisson for steals, much wider for points), padded for the
 * projection itself being wrong (minutes, rest days, hot and cold weeks).
 */
const DISPERSION: Record<Counting, number> = {
  fg3m: 1.6, pts: 5, reb: 2.6, ast: 2.2, stl: 1.5, blk: 1.8, tov: 1.5,
};
/** The same padding for shooting: makes vary binomially over the attempts left. */
const PCT_DISPERSION = 1.5;

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, error under 1.5e-7). */
function phi(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Expected margin (left side's way: fewer turnovers is better) and its spread. */
function spread(k: CategoryKey, a: CategoryLine, aProj: CategoryLine, b: CategoryLine, bProj: CategoryLine): [number, number] {
  if (k === "fgPct" || k === "ftPct") {
    const [m, at] = k === "fgPct" ? (["fgm", "fga"] as const) : (["ftm", "fta"] as const);
    const side = (now: CategoryLine, proj: CategoryLine) => {
      const p = proj[at] > 0 ? proj[m] / proj[at] : 0;
      const left = Math.max(0, proj[at] - now[at]);
      // A side with no attempts at all has no percentage yet; count it as level with the league.
      const v = proj[at] > 0 ? (PCT_DISPERSION * left * p * (1 - p)) / proj[at] ** 2 : 0;
      return { p, v, any: proj[at] > 0 };
    };
    const x = side(a, aProj);
    const y = side(b, bProj);
    if (!x.any || !y.any) return [x.any ? 1 : y.any ? -1 : 0, 0];
    return [x.p - y.p, Math.sqrt(x.v + y.v)];
  }
  const left = (now: CategoryLine, proj: CategoryLine) => Math.max(0, proj[k] - now[k]);
  const sd = Math.sqrt(DISPERSION[k] * (left(a, aProj) + left(b, bProj)));
  const margin = aProj[k] - bProj[k];
  return [k === "tov" ? -margin : margin, sd];
}

function tierOf(chance: number): OddsTier {
  if (chance >= 0.9) return "safe";
  if (chance >= 0.65) return "ahead";
  if (chance > 0.35) return "tossup";
  return chance > 0.1 ? "behind" : "gone";
}

/** One category's odds for the left side (`a`), from both sides' actual and projected week totals. */
export function categoryOdds(k: CategoryKey, a: CategoryLine, aProj: CategoryLine, b: CategoryLine, bProj: CategoryLine): CategoryOdds {
  const [margin, sd] = spread(k, a, aProj, b, bProj);
  // Nothing left to play: decided (a hair's width either way is still a win).
  if (sd < 1e-9) {
    if (Math.abs(margin) < 1e-9) return { chance: 0.5, tier: "tied" };
    return margin > 0 ? { chance: 1, tier: "won" } : { chance: 0, tier: "lost" };
  }
  const chance = phi(margin / sd);
  return { chance, tier: tierOf(chance) };
}

/** Every category's odds for the left side. */
export function matchupOdds(a: CategoryLine, aProj: CategoryLine, b: CategoryLine, bProj: CategoryLine): Record<CategoryKey, CategoryOdds> {
  return Object.fromEntries(CATEGORY_KEYS.map((k) => [k, categoryOdds(k, a, aProj, b, bProj)])) as Record<CategoryKey, CategoryOdds>;
}

/** "62%"; ">99%" and "<1%" at the ends, so a live category never reads as certain. */
export function fmtChance(o: CategoryOdds): string {
  if (o.tier === "won") return "Won";
  if (o.tier === "lost") return "Lost";
  if (o.tier === "tied") return "Tied";
  const pct = Math.round(o.chance * 100);
  return pct >= 100 ? ">99%" : pct <= 0 ? "<1%" : `${pct}%`;
}

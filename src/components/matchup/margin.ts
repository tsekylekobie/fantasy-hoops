// How lopsided a matchup is, for the bar on the Matchup page: the gap in
// categories won, so 5–4 is close and 8–1 is a blowout. Works on any score,
// actual or projected.
import type { MatchupScore } from "@/lib/types";

export type MarginTier = "tied" | "close" | "clear" | "blowout";

export interface MatchupMargin {
  /** Categories won minus categories lost, as a positive number. */
  margin: number;
  /** Who's ahead: the score's own side (wins) or the other one (losses). */
  leader: "team" | "opponent" | null;
  tier: MarginTier;
  /** "Close · by 1"; "Tied" when level. */
  label: string;
}

const TIER_LABELS: Record<Exclude<MarginTier, "tied">, string> = { close: "Close", clear: "Clear", blowout: "Blowout" };

function tierOf(margin: number): Exclude<MarginTier, "tied"> {
  if (margin >= 5) return "blowout"; // 7–2, 6–1–2
  return margin >= 3 ? "clear" : "close"; // 6–3, 5–2–2 : 5–4, 5–3–1
}

/** Null until a category is decided (every one tied: nothing has been played yet). */
export function matchupMargin(s: MatchupScore): MatchupMargin | null {
  if (s.wins === 0 && s.losses === 0) return null;
  const margin = Math.abs(s.wins - s.losses);
  if (margin === 0) return { margin, leader: null, tier: "tied", label: "Tied" };
  const tier = tierOf(margin);
  return { margin, leader: s.wins > s.losses ? "team" : "opponent", tier, label: `${TIER_LABELS[tier]} · by ${margin}` };
}

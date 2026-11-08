// What Flash's badge describes. Kept out of Flash.tsx ("use client") so server
// components, like the Matchup page, can build a delta while rendering: a client
// module's functions can't be called from the server.

/**
 * A count or rank compares `n`; shooting compares makes/attempts ("+2/3"),
 * colored by what the shots did to the percentage.
 */
export type FlashDelta =
  | { kind: "count" | "rank"; n: number | null; lowerIsBetter?: boolean }
  | { kind: "shots"; made: number; att: number };

/** A count's change for the badge ("+1"); TO and fouls are lower-is-better (red when they go up). */
export const countDelta = (n: number, lowerIsBetter = false): FlashDelta => ({ n, kind: "count", lowerIsBetter });

/** Shooting's change for the badge ("+2/3"). */
export const shotsDelta = (made: number, att: number): FlashDelta => ({ kind: "shots", made, att });

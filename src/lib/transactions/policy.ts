// Whether a roster move happens now or waits for the waiver run. This is the
// one place that decides it; runRosterMove (queries/transactions.ts) acts on
// the answer and queries/waivers.ts runs the claims at the league's daily
// waiver time (leagues.waiver_time in leagues.time_zone).
//
//   - addMode is "waiver" for players in waiver_players (dropped recently) and,
//     if leagues.waivers_after_game_start, for every free agent once his game
//     today has tipped off. runRosterMove then records a pending 'waiver_claim'
//     (process_at = the run when he clears) instead of moving him.
//   - dropDestination is "waivers" unless the league's waiver_days is 0;
//     runRosterMove then inserts a waiver_players row that clears at the first
//     waiver run at least waiver_days after the drop.
//   - In FAAB leagues a claim carries a blind bid (faabBidProblem); a free
//     agent who isn't on waivers is still an immediate add, for nothing.

import type { AddMode, FaabBudget } from "../types";

/** League settings the policy reads (a subset of the leagues row). */
export interface MovePolicyLeague {
  waiverDays: number;
  waiversAfterGameStart: boolean;
}

/** What we know about the player being added. */
export interface AddTarget {
  /** Has an uncleared waiver_players row (dropped within waiver_days). */
  onWaivers: boolean;
  /** His NBA game today has tipped off. */
  gameStarted: boolean;
}

export function addMode(league: MovePolicyLeague, player: AddTarget): AddMode {
  return player.onWaivers || (league.waiversAfterGameStart && player.gameStarted) ? "waiver" : "immediate";
}

export function dropDestination(league: MovePolicyLeague): "free_agents" | "waivers" {
  return league.waiverDays > 0 ? "waivers" : "free_agents";
}

/**
 * Why a FAAB bid can't be placed (or changed to), or null when it can: whole
 * dollars from the league's minimum bid up to the team's balance. Pending bids
 * don't reserve money, so several can each go up to the whole balance; the
 * waiver run checks each against what's left when it gets to it.
 */
export function faabBidProblem(faab: FaabBudget, bid: unknown): string | null {
  if (typeof bid !== "number" || !Number.isInteger(bid)) return "Bids are whole dollars.";
  if (bid < faab.minBid) return faab.minBid === 0 ? "Bids can't be negative." : `The minimum bid is $${faab.minBid}.`;
  if (bid > faab.balance) return `You only have $${faab.balance} left to bid.`;
  return null;
}

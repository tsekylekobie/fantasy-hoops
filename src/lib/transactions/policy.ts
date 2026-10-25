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

import type { AddMode } from "../types";

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

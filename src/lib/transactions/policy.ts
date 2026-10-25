// Whether a roster move happens now or waits for the waiver run. This is the
// one place that decides it, so waivers (and their configurable daily
// processing time, leagues.waiver_time) plug in here without touching the
// add/drop code in queries/transactions.ts.
//
// Today every add is immediate and a dropped player goes straight back to free
// agents. When waivers ship:
//   - addMode returns "waiver" for players in waiver_players (and for
//     everyone once their game starts if leagues.waivers_after_game_start),
//     and runRosterMove records a pending 'waiver_claim' with process_at
//     instead of moving the player;
//   - dropDestination returns "waivers", and runRosterMove inserts a
//     waiver_players row (clears_at from leagues.waiver_days).

import type { AddMode } from "../types";

/** League settings the policy reads (a subset of the leagues row). */
export interface MovePolicyLeague {
  waiverDays: number;
  waiversAfterGameStart: boolean;
}

/** What we know about the player being added. */
export interface AddTarget {
  /** Has an uncleared waiver_players row. Always false until drops start writing them. */
  onWaivers: boolean;
  /** His NBA game today has tipped off. */
  gameStarted: boolean;
}

export function addMode(_league: MovePolicyLeague, _player: AddTarget): AddMode {
  return "immediate";
}

export function dropDestination(_league: MovePolicyLeague): "free_agents" | "waivers" {
  return "free_agents";
}

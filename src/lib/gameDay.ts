// The date pages show as "today" (Box scores, Matchup, My team and team lineups) is the Pacific date, so a
// night's games stay today until the last West Coast game is over (Eastern would roll over mid-game). Display
// only: lineup locks, adds/drops, waivers and trades keep the league's own date (TeamContext.today).
export const GAME_DAY_TZ = "America/Los_Angeles";

/** Today's Pacific date, yyyy-mm-dd. */
export function gameDayToday(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: GAME_DAY_TZ });
}

// "Today" for game-day pages (Box scores, Matchup, My team and team lineups) is the Pacific date, so a night's
// games stay today until the last West Coast game is over (Eastern would roll over mid-game). Tip-off times
// still show in the league's time zone; waivers, trades and settings keep the league's own date.
export const GAME_DAY_TZ = "America/Los_Angeles";

// Date windows for the Players page's streaming filters (?plays= and ?waivers=).
// Pure, unit tested. "Today" is the league's calendar day, like lineups
// ((now() AT TIME ZONE leagues.time_zone)::date), and games match on games.date.
import { PLAY_DAYS, type PlayDay } from "../types";

/** The calendar date (yyyy-mm-dd) of an instant in a time zone. */
export function zonedDate(at: Date, timeZone: string): string {
  // en-CA formats as yyyy-mm-dd.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** yyyy-mm-dd plus `days` calendar days (date arithmetic in UTC, so no DST shifts). */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Today, tomorrow and the day after in the league's time zone. Nothing further out. */
export function streamDates(now: Date, timeZone: string): Record<PlayDay, string> {
  const today = zonedDate(now, timeZone);
  return { today, tomorrow: addDays(today, 1), in2: addDays(today, 2) };
}

/** The dates the chosen days stand for, in PLAY_DAYS order. */
export function playDates(days: readonly PlayDay[], dates: Record<PlayDay, string>): string[] {
  return PLAY_DAYS.filter((d) => days.includes(d)).map((d) => dates[d]);
}

/**
 * True when a waiver clear time falls before the end of tomorrow in league
 * time: the same league-time date the Claim button shows ("Claim (Mon, Oct 26)").
 */
export function clearsByTomorrow(clearsAt: string, timeZone: string, now: Date): boolean {
  return zonedDate(new Date(clearsAt), timeZone) <= streamDates(now, timeZone).tomorrow;
}

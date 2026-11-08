// Number and label formatting shared by the players table and the player modal.
import type { PlayerInjury, PlayerUpcomingGame, PlayerWaiver } from "@/lib/types";

/** 0.492 -> ".492"; 1 -> "1.000"; null -> "—" */
export function fmtPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const s = value.toFixed(3);
  return s.startsWith("0") ? s.slice(1) : s;
}

/** One decimal, for per-game values. */
export function fmtAvg(value: number): string {
  return value.toFixed(1);
}

/** 9CAT value with two decimals and a real minus sign: 7.4 -> "7.40", -1.2 -> "−1.20". */
export function fmtValue(value: number): string {
  return value < 0 ? `\u2212${Math.abs(value).toFixed(2)}` : value.toFixed(2);
}

/** A whole number with no thousands separator ("2145"), so wide totals stay narrow in the stat columns. */
export function fmtInt(value: number): string {
  return String(Math.round(value));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-21" -> "Oct 21" (parsed as a plain date, so no time zone shift). */
export function fmtGameDate(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!m || !d || m < 1 || m > 12) return iso;
  return `${MONTHS[m - 1]} ${d}`;
}

/** "Left Calf Strain · Est. return Oct 28", skipping missing parts; "" when neither is known. */
export function fmtInjuryLine(i: PlayerInjury): string {
  return [i.injury, i.returnDate && `Est. return ${fmtGameDate(i.returnDate)}`].filter(Boolean).join(" · ");
}

/** Today's date ("2026-11-03") in `timeZone` (the league's; Eastern when the page doesn't have it). */
export function todayIn(timeZone = "America/New_York", now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone });
}

/**
 * The status chip text: "Out 5D", "Out 3W", "Out 2M" (time until the estimated return, under
 * 14 days in days, under 60 in weeks, then months); just the status when there's no return
 * date, it isn't Out, or the return is today or past. Day-To-Day is "DTD".
 */
export function fmtInjuryStatus(i: PlayerInjury, today: string): string {
  if (/^day[- ]to[- ]day$/i.test(i.status)) return "DTD";
  if (i.status !== "Out" || !i.returnDate) return i.status;
  const days = Math.round((Date.parse(i.returnDate.slice(0, 10)) - Date.parse(today)) / 86_400_000);
  if (!(days > 0)) return i.status;
  if (days < 14) return `Out ${days}D`;
  if (days < 60) return `Out ${Math.round(days / 7)}W`;
  return `Out ${Math.round(days / 30.44)}M`;
}

/** "@ CHI · W" / "vs ORL · L" */
export function fmtOpponent(opponentAbbr: string, home: boolean, result: "W" | "L" | null): string {
  const base = `${home ? "vs" : "@"} ${opponentAbbr}`;
  return result ? `${base} · ${result}` : base;
}

/** Fetch JSON; on a non-2xx response, throw with the API's `{ error }` message when present. */
export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    let message = res.status === 404 ? "Not found." : `Request failed (${res.status}).`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error) message = body.error;
    } catch {
      // Non-JSON error body: keep the generic message.
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function fullName(p: { firstName: string; lastName: string }): string {
  return `${p.firstName} ${p.lastName}`.trim();
}

/** "TEAM · POS", skipping missing parts. */
export function teamPos(team: string | null, pos: string | null): string {
  return [team, pos].filter(Boolean).join(" · ") || "Free agent";
}

/**
 * A waiver run time in the league's time zone: "Sun 3:00 AM" (short),
 * "Sun, Oct 27 · 3:00 AM ET" (long), "Sunday at 3:00 AM ET" (sentence),
 * "Sun, Oct 27" (date, for Claim buttons), or "Oct 27" (day, the Players table's Claim).
 */
export function fmtWaiverTime(
  iso: string, timeZone: string, style: "short" | "long" | "sentence" | "date" | "day" = "short",
): string {
  const d = new Date(iso);
  const weekday = d.toLocaleDateString("en-US", { weekday: style === "sentence" ? "long" : "short", timeZone });
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  const zone =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortGeneric" }).formatToParts(d).find((p) => p.type === "timeZoneName")
      ?.value ?? "";
  if (style === "short") return `${weekday} ${time}`;
  if (style === "date") return `${weekday}, ${date}`;
  if (style === "day") return date;
  if (style === "sentence") return `${weekday} at ${time} ${zone}`.trim();
  return `${weekday}, ${date} · ${time} ${zone}`.trim();
}

/** A streaming-filter game: "Tomorrow vs LAL 7:30 PM", "Tue @ BOS 8:00 PM" (in the league's time zone). */
export function fmtUpcomingGame(g: PlayerUpcomingGame, timeZone: string): string {
  const [y, m, d] = g.date.split("-").map(Number);
  const day =
    g.day === "today" ? "Today"
    : g.day === "tomorrow" ? "Tomorrow"
    : new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const time = g.tipoff ? new Date(g.tipoff).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone }) : "TBD";
  return `${day} ${g.home ? "vs" : "@"} ${g.opponentAbbr} ${time}`;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Waiver run days (ISO weekdays, 1 = Mon): "daily", "on weekdays", or "on Tue, Fri". */
export function fmtWaiverDays(days: number[]): string {
  const set = new Set(days);
  if (set.size === 7) return "daily";
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return "on weekdays";
  return `on ${[...set].sort((a, b) => a - b).map((d) => WEEKDAYS[d - 1]).join(", ")}`;
}

/** Tooltip for a Claim button: when the claim is decided. */
export function waiverTooltip(waiver: PlayerWaiver, timeZone: string): string {
  const when = fmtWaiverTime(waiver.clearsAt, timeZone, "long");
  return waiver.reason === "all_adds" ? `Free agent. Claims process ${when}` : `On waivers until ${when}`;
}

/**
 * A game's status, short: "2nd Qtr" -> "2Q", "Q4 5:06" -> "4Q 5:06", "Halftime" -> "Half",
 * overtime numbered from 1 ("OT 2:10" -> "1OT 2:10", "OT2"/"2nd OT" -> "2OT", "Final/OT" -> "Final/1OT"); anything else as is.
 */
export function fmtGameStatus(status: string): string {
  if (/^half/i.test(status)) return "Half";
  return status
    .replace(/(^|\/)(?:OT(\d)?|(\d)(?:st|nd|rd|th)? ?OT)\b/i, (_m, pre: string, a?: string, b?: string) => `${pre}${a ?? b ?? "1"}OT`)
    .replace(/^(\d)(?:st|nd|rd|th) Qtr\b/i, "$1Q")
    .replace(/^Q(\d)\b/, "$1Q");
}

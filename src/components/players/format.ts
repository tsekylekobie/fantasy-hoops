// Number and label formatting shared by the players table and the player modal.
import type { PlayerInjury, PlayerUpcomingGame } from "@/lib/types";

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

/** Whole number, for totals and single games. */
export function fmtInt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
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

/** Hover text for a player row: "Out · Left Calf Strain · Est. return Oct 28", then the news blurb. */
export function injuryTooltip(i: PlayerInjury | null): string | undefined {
  if (!i) return undefined;
  const line = [i.status, fmtInjuryLine(i)].filter(Boolean).join(" · ");
  if (!i.note) return line;
  const note = i.note.length > 240 ? `${i.note.slice(0, 240).replace(/\s+\S*$/, "")}…` : i.note;
  return `${line}\n${note}`;
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
 * or "Sun, Oct 27" (date, for Claim buttons).
 */
export function fmtWaiverTime(iso: string, timeZone: string, style: "short" | "long" | "sentence" | "date" = "short"): string {
  const d = new Date(iso);
  const weekday = d.toLocaleDateString("en-US", { weekday: style === "sentence" ? "long" : "short", timeZone });
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  const zone =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortGeneric" }).formatToParts(d).find((p) => p.type === "timeZoneName")
      ?.value ?? "";
  if (style === "short") return `${weekday} ${time}`;
  if (style === "date") return `${weekday}, ${date}`;
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

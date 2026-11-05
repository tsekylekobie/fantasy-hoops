"use client";

import { useSyncExternalStore } from "react";

/** "Oct 25 · 2:48 PM" in `timeZone`. */
function fmtWhen(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  return `${day} · ${time}`;
}

const neverChanges = () => () => {};
const viewerTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * A timestamp in the viewer's time zone. The server can't know that zone, so the
 * page is rendered with the league's and the browser swaps in the viewer's on hydration.
 */
export default function LocalTime({ iso, leagueTimeZone, className }: { iso: string; leagueTimeZone: string; className?: string }) {
  const timeZone = useSyncExternalStore(neverChanges, viewerTimeZone, () => leagueTimeZone);
  return (
    <time className={className} dateTime={iso}>
      {fmtWhen(iso, timeZone)}
    </time>
  );
}

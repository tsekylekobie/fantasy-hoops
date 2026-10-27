"use client";

// Calls `poll` every LIVE_POLL_MS while `active` and the tab is visible, and
// once right away when the tab comes back. The worker writes live stats every
// couple of minutes, so polling more often than this buys nothing.
import { useEffect, useRef } from "react";

export const LIVE_POLL_MS = 30_000;

export function useLivePoll(active: boolean, poll: () => void): void {
  const latest = useRef(poll);
  latest.current = poll;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") latest.current();
    }, LIVE_POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && latest.current();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active]);
}

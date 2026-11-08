"use client";

// Calls `poll` every LIVE_POLL_MS while `active` and the tab is visible, and
// once right away when the tab comes back. The worker writes live stats every
// 30s (WORKER_LIVE_SECONDS), so polling more often than this buys nothing.
// Returns when the next poll is due (epoch ms; LiveCountdown shows it), or
// null while inactive or the tab is hidden (nothing is scheduled then).
import { useEffect, useRef, useState } from "react";

export const LIVE_POLL_MS = 30_000;

export function useLivePoll(active: boolean, poll: () => void): number | null {
  const latest = useRef(poll);
  latest.current = poll;
  const [nextAt, setNextAt] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(tick, LIVE_POLL_MS);
      setNextAt(Date.now() + LIVE_POLL_MS);
    };
    const pause = () => {
      clearTimeout(timer);
      setNextAt(null);
    };
    function tick() {
      if (document.visibilityState !== "visible") return pause();
      latest.current();
      schedule();
    }
    const onVisibility = () => (document.visibilityState === "visible" ? tick() : pause());
    if (document.visibilityState === "visible") schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active]);
  return active ? nextAt : null;
}

"use client";

// "Next update in 12s" beside a ring that drains until the next live poll
// (useLivePoll's `nextAt`, set as each wait starts, so the ring remounts
// with it and runs the full LIVE_POLL_MS), then "Updating…" while the fresh data loads.
// Not a live region: a screen reader would otherwise read it every second.
// Kept on one line (it wraps as a unit on narrow screens).
import { useEffect, useState } from "react";
import { LIVE_POLL_MS } from "./useLivePoll";
import styles from "./LiveCountdown.module.css";

const R = 5.5;
const C = 2 * Math.PI * R;

export default function LiveCountdown({ nextAt, pending }: { nextAt: number | null; pending: boolean }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const left = nextAt !== null && now !== null ? Math.max(0, Math.ceil((nextAt - now) / 1000)) : null;
  const updating = pending || left === 0;
  return (
    <span className={styles.cd} data-updating={updating || undefined} title={`Live games update every ${LIVE_POLL_MS / 1000} seconds`}>
      <svg className={styles.ring} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle className={styles.track} cx="7" cy="7" r={R} />
        {nextAt !== null && !updating && (
          <circle
            key={nextAt}
            className={styles.fill}
            cx="7"
            cy="7"
            r={R}
            strokeDasharray={C}
            style={{ "--c": C, animationDuration: `${LIVE_POLL_MS}ms` } as React.CSSProperties}
          />
        )}
      </svg>
      {updating ? "Updating…" : left === null ? "Live" : `Next update in ${left}s`}
    </span>
  );
}

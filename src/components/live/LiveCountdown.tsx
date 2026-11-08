"use client";

// "Next update in 12s" beside a ring that drains until the next live poll
// (useLivePoll's `nextAt`, set as each wait starts, so the ring remounts
// with it and runs the full LIVE_POLL_MS), then "Updating…" while the fresh data loads.
// Not a live region: a screen reader would otherwise read it every second.
// Kept on one line (it wraps as a unit on narrow screens).
//
// `compact` shows just "12s" (for a tight spot like Box scores' pinned bar).
// `pin`: once the countdown has scrolled off the top, a small copy floats at
// the top of the screen (fixed, centered, never blocking taps) until it's back.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LIVE_POLL_MS } from "./useLivePoll";
import styles from "./LiveCountdown.module.css";

const R = 5.5;
const C = 2 * Math.PI * R;

type Props = { nextAt: number | null; pending: boolean; compact?: boolean; pin?: boolean };

export default function LiveCountdown({ nextAt, pending, compact = false, pin = false }: Props) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const left = nextAt !== null && now !== null ? Math.max(0, Math.ceil((nextAt - now) / 1000)) : null;
  const updating = pending || left === 0;

  // Pinned while the inline countdown is above the viewport (scrolled past, not below it).
  const ref = useRef<HTMLSpanElement>(null);
  const [scrolledOff, setScrolledOff] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!pin || !el) return;
    const io = new IntersectionObserver(([e]) => setScrolledOff(!e.isIntersecting && e.boundingClientRect.top < 0));
    io.observe(el);
    return () => io.disconnect();
  }, [pin]);

  const ring = (
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
  );
  const label = (short: boolean) =>
    updating ? "Updating…" : left === null ? "Live" : short ? `${left}s` : `Next update in ${left}s`;
  const title = `Live games update every ${LIVE_POLL_MS / 1000} seconds`;

  return (
    <>
      <span ref={ref} className={styles.cd} data-updating={updating || undefined} title={title}>
        {ring}
        {label(compact)}
      </span>
      {pin && scrolledOff && createPortal(
        <span className={`${styles.cd} ${styles.pinned}`} data-updating={updating || undefined} aria-hidden="true">
          {ring}
          {label(false)}
        </span>,
        document.body,
      )}
    </>
  );
}

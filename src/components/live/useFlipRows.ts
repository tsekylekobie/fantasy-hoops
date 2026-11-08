"use client";

// Slides rows to their new place when a live update reorders them, instead of
// letting them jump (the "FLIP" technique: note where each row was, and after
// the re-render, start it there and animate it home). Rows are the elements
// under `ref` with a `data-flip` key; a row seen for the first time just
// appears. Skipped with prefers-reduced-motion.
import { useLayoutEffect, useRef, type RefObject } from "react";

export function useFlipRows(ref: RefObject<HTMLElement | null>): void {
  const tops = useRef(new Map<string, number>());
  // Every render: a reorder can come from any re-render with fresh data.
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, number>();
    for (const row of box.querySelectorAll<HTMLElement>("[data-flip]")) {
      const key = row.dataset.flip!;
      const top = row.offsetTop; // layout position, unaffected by a running transform
      next.set(key, top);
      const was = tops.current.get(key);
      if (was === undefined || was === top || reduce) continue;
      // Mid-slide, start from where the row is now on screen (old place plus the
      // running offset), or a re-render's 1px nudge would snap a long slide to its end.
      const running = row.getAnimations();
      const offset = running.length ? new DOMMatrixReadOnly(getComputedStyle(row).transform).m42 : 0;
      const from = was + offset - top;
      running.forEach((a) => a.cancel());
      if (Math.abs(from) < 2) continue;
      const anim = row.animate([{ transform: `translateY(${from}px)` }, { transform: "none" }], {
        duration: 500,
        easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
      });
      // A row moving up is the news: it passes over the rows it overtakes
      // ([data-flip-rising] in globals.css), not under their sticky cells.
      if (from > 0) {
        row.setAttribute("data-flip-rising", "");
        // Unless a newer slide took over (a cancel's event comes after it started).
        const done = () => row.getAnimations().length === 0 && row.removeAttribute("data-flip-rising");
        anim.onfinish = done;
        anim.oncancel = done;
      }
    }
    tops.current = next;
  });
}

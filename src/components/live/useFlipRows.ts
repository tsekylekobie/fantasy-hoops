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
      row.animate([{ transform: `translateY(${was - top}px)` }, { transform: "none" }], {
        duration: 500,
        easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
      });
    }
    tops.current = next;
  });
}

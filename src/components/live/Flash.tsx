"use client";

// A cell that briefly highlights when its value changes (live stat updates).
// `value` is what's compared: the first render never flashes, so a page load
// or a remount (new week, day or team) stays quiet; only a change between
// renders of the same cell does, except from null (a line appearing at
// tip-off would light up every cell at once). `scope` is what the value
// belongs to (a player, a day): when it changes too, say a lineup move puts
// someone else in the row, the new value is taken as is, without a flash.
// The highlight is a CSS animation on [data-flash] (globals.css), restarted
// on every change.
//
// `delta` also shows the change itself for a moment, a small badge on the
// cell ([data-delta] in globals.css): "+2" for a count (green when it's good,
// red when it isn't, so TO is lower-is-better), "▲3" for a rank (a smaller
// number is better). The difference is taken over `delta.n`, which can differ
// from `value`: a rank cell passes the player's Value as `value`, so it only
// lights up when his own line changed, not when others' lines moved him.
// With a delta, nothing flashes unless `delta.n` changed too.
import { useEffect, useRef } from "react";

type Value = string | number | null;
export type FlashDelta = { n: number | null; kind: "count" | "rank"; lowerIsBetter?: boolean };
type Props = React.HTMLAttributes<HTMLElement> & {
  value: Value;
  scope?: Value;
  delta?: FlashDelta;
  as?: "span" | "b" | "div" | "em";
};

function restart(el: HTMLElement, attr: string, val = "") {
  el.removeAttribute(attr);
  void el.offsetWidth; // restart the animation if it's still running
  el.setAttribute(attr, val);
}

function deltaText(d: number, delta: FlashDelta): { text: string; good: boolean } {
  if (delta.kind === "rank") return { text: d < 0 ? `▲${-d}` : `▼${d}`, good: d < 0 };
  return { text: d > 0 ? `+${d}` : `−${-d}`, good: (d > 0) !== !!delta.lowerIsBetter };
}

export default function Flash({ value, scope = null, delta, as: Tag = "span", children, ...rest }: Props) {
  const ref = useRef<HTMLElement>(null);
  const n = delta?.n ?? null;
  const prev = useRef({ value, scope, n });
  useEffect(() => {
    const was = prev.current;
    if (was.value === value && was.scope === scope && was.n === n) return;
    prev.current = { value, scope, n };
    const el = ref.current;
    if (!el || was.value === null || was.value === value || was.scope !== scope) return;
    if (delta) {
      if (n === null || was.n === null || n === was.n) return;
      const { text, good } = deltaText(n - was.n, delta);
      el.setAttribute("data-delta-good", String(good));
      el.setAttribute("data-delta-kind", delta.kind);
      restart(el, "data-delta", text);
    }
    restart(el, "data-flash");
    // `delta` is read only alongside `n`, which is in the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, scope, n]);
  return (
    <Tag
      ref={ref as React.RefObject<never>}
      {...rest}
      onAnimationEnd={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.animationName.startsWith("flash-delta")) e.currentTarget.removeAttribute("data-delta");
        else if (e.animationName === "flash") e.currentTarget.removeAttribute("data-flash");
      }}
    >
      {children}
    </Tag>
  );
}

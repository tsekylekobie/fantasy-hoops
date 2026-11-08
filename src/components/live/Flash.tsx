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
// `delta` also shows the change itself for a moment: a small badge in the
// cell (.flash-delta in globals.css; a real element, so it never collides with
// a page's own ::before/::after, and hidden from screen readers): "+2" for a
// count (green when it's good, red when it isn't, so TO is lower-is-better),
// "▲3" for a rank (a smaller number is better), "+2/3" for shooting (green or
// red by what it did to the percentage, grey when unchanged). The difference is
// taken over the delta, which can differ from `value`: a rank cell passes the
// player's Value as `value`, so it only lights up when his own line changed,
// not when others' lines moved him. With a delta, nothing flashes unless the
// delta changed too.
import { useEffect, useRef, useState } from "react";
import type { FlashDelta } from "./flashDelta";

type Value = string | number | null;
type Props = React.HTMLAttributes<HTMLElement> & {
  value: Value;
  scope?: Value;
  delta?: FlashDelta;
  as?: "span" | "b" | "div" | "em";
};
/** `good` null: neither (grey). */
type Shown = { text: string; good: boolean | null };
type Badge = Shown & { id: number; kind: FlashDelta["kind"] };

/** What's compared between renders: the badge only shows when this moved. */
function deltaKey(d: FlashDelta | undefined): string | number | null {
  if (!d) return null;
  return d.kind === "shots" ? `${d.made}/${d.att}` : d.n;
}

function badgeFor(was: FlashDelta, now: FlashDelta): Shown | null {
  if (now.kind === "shots" && was.kind === "shots") {
    const dm = now.made - was.made;
    const da = now.att - was.att;
    if (da <= 0 || dm < 0 || dm > da) return null; // a stat correction, not new shots
    const text = `+${dm}/${da}`;
    // Green when the percentage went up, red when down, grey when unchanged (1/2 → 2/4).
    // With no earlier attempts there's no percentage to move: all in green, all missed red.
    if (was.att === 0) return { text, good: dm === da ? true : dm === 0 ? false : null };
    const diff = now.made * was.att - was.made * now.att; // sign of now% − was%
    return { text, good: diff > 0 ? true : diff < 0 ? false : null };
  }
  if (now.kind === "shots" || was.kind === "shots" || now.n === null || was.n === null) return null;
  const d = now.n - was.n;
  if (d === 0) return null;
  if (now.kind === "rank") return { text: d < 0 ? `▲${-d}` : `▼${d}`, good: d < 0 };
  return { text: d > 0 ? `+${d}` : `−${-d}`, good: (d > 0) !== !!now.lowerIsBetter };
}

export default function Flash({ value, scope = null, delta, as: Tag = "span", children, ...rest }: Props) {
  const ref = useRef<HTMLElement>(null);
  const key = deltaKey(delta);
  const prev = useRef({ value, scope, key, delta });
  const [badge, setBadge] = useState<Badge | null>(null);
  useEffect(() => {
    const was = prev.current;
    if (was.value === value && was.scope === scope && was.key === key) return;
    prev.current = { value, scope, key, delta };
    const el = ref.current;
    if (!el || was.value === null || was.value === value || was.scope !== scope) return;
    if (delta) {
      if (key === null || was.key === null || key === was.key || !was.delta) return;
      const shown = badgeFor(was.delta, delta);
      // A new id remounts the badge, restarting its animation. No badge (a
      // correction): the cell still flashes.
      if (shown) setBadge((b) => ({ id: (b?.id ?? 0) + 1, kind: delta.kind, ...shown }));
    }
    el.removeAttribute("data-flash");
    void el.offsetWidth; // restart the animation if it's still running
    el.setAttribute("data-flash", "");
    // `delta` is read only alongside `key`, which is in the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, scope, key]);
  return (
    <Tag
      ref={ref as React.RefObject<never>}
      {...rest}
      data-delta={badge ? "" : undefined}
      onAnimationEnd={(e) => e.target === e.currentTarget && e.currentTarget.removeAttribute("data-flash")}
    >
      {children}
      {badge && (
        <span
          key={badge.id}
          className="flash-delta"
          data-good={badge.good === null ? "neutral" : badge.good}
          data-kind={badge.kind}
          aria-hidden="true"
          onAnimationEnd={(e) => {
            e.stopPropagation();
            setBadge(null);
          }}
        >
          {badge.text}
        </span>
      )}
    </Tag>
  );
}

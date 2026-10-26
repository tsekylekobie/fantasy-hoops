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
import { useEffect, useRef } from "react";

type Value = string | number | null;
type Props = React.HTMLAttributes<HTMLElement> & { value: Value; scope?: Value; as?: "span" | "b" | "div" };

export default function Flash({ value, scope = null, as: Tag = "span", children, ...rest }: Props) {
  const ref = useRef<HTMLElement>(null);
  const prev = useRef({ value, scope });
  useEffect(() => {
    const was = prev.current;
    if (was.value === value && was.scope === scope) return;
    prev.current = { value, scope };
    const el = ref.current;
    if (!el || was.value === null || was.value === value || was.scope !== scope) return;
    el.removeAttribute("data-flash");
    void el.offsetWidth; // restart the animation if it's still running
    el.setAttribute("data-flash", "");
  }, [value, scope]);
  return (
    <Tag ref={ref as React.RefObject<never>} {...rest} onAnimationEnd={(e) => e.currentTarget.removeAttribute("data-flash")}>
      {children}
    </Tag>
  );
}

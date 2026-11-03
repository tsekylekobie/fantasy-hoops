"use client";

// A wide table that scrolls sideways inside its card while its header row stays
// pinned to the top of the page. A scroller clips vertical stickiness, so the
// header is drawn twice: once in the table (for layout and screen readers) and
// once in a page-sticky copy laid over it, sized to the real columns and kept at
// the table's scroll position. The root gets `data-scrolled` once the table is
// scrolled sideways, which ScrollName (and page CSS) key off.
import { useLayoutEffect, useRef, type ReactNode } from "react";
import styles from "./StickyHeadTable.module.css";

interface Props {
  /** The root, which bounds how far the header stays pinned. */
  className?: string;
  tableClassName?: string;
  /** The `<thead>`; `copy` is true for the pinned copy (keep its controls out of the tab order). */
  head: (copy: boolean) => ReactNode;
  /** The real table's `<colgroup>`, if any (the copy gets its own, measured). */
  cols?: ReactNode;
  /** tbody, tfoot. */
  children: ReactNode;
  busy?: boolean;
}

export default function StickyHeadTable({ className = "", tableClassName, cols: colgroup, head, children, busy }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pinRef = useRef<HTMLDivElement>(null);
  const pinScrollRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLTableElement>(null);
  const colsRef = useRef<HTMLTableColElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current, pin = pinRef.current, pinScroll = pinScrollRef.current, copy = copyRef.current;
    const cols = colsRef.current, scroll = scrollRef.current, table = tableRef.current;
    if (!root || !pin || !pinScroll || !copy || !cols || !scroll || !table) return;

    const sync = () => {
      pinScroll.scrollLeft = scroll.scrollLeft;
      root.toggleAttribute("data-scrolled", scroll.scrollLeft > 2);
    };

    // Copy the real columns' widths and the header's height onto the pinned copy,
    // and pull the table up under it so the copy stands in for the real header.
    const measure = () => {
      const cells = table.tHead?.rows[0]?.cells;
      const body = table.tBodies[0];
      if (!cells || !body) return;
      while (cols.children.length < cells.length) cols.appendChild(document.createElement("col"));
      while (cols.children.length > cells.length) cols.lastChild!.remove();
      for (let i = 0; i < cells.length; i++) {
        (cols.children[i] as HTMLElement).style.width = `${cells[i].getBoundingClientRect().width}px`;
      }
      const width = `${table.getBoundingClientRect().width}px`;
      copy.style.width = width;
      copy.style.minWidth = width;
      const height = body.getBoundingClientRect().top - table.getBoundingClientRect().top;
      pin.style.height = `${height}px`;
      scroll.style.marginTop = `${-height}px`;
      sync();
      root.setAttribute("data-ready", "");
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(table);
    for (const th of Array.from(table.tHead?.rows[0]?.cells ?? [])) ro.observe(th);
    scroll.addEventListener("scroll", sync, { passive: true });
    return () => {
      ro.disconnect();
      scroll.removeEventListener("scroll", sync);
    };
  }, []);

  return (
    <div ref={rootRef} className={`${styles.root} ${className}`} aria-busy={busy}>
      <div ref={pinRef} className={styles.pin} aria-hidden="true">
        <div ref={pinScrollRef} className={styles.pinScroll}>
          <table ref={copyRef} className={`${tableClassName ?? ""} ${styles.copy}`}>
            <colgroup ref={colsRef} />
            {head(true)}
          </table>
        </div>
      </div>
      <div ref={scrollRef} className={styles.scroll}>
        <table ref={tableRef} className={tableClassName}>
          {colgroup}
          {head(false)}
          {children}
        </table>
      </div>
    </div>
  );
}

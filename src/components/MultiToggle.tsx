"use client";

// SegmentedToggle's pill for options that combine (Tomorrow + In 2 days): each
// option toggles on its own, and the leading "any" option clears them all.
import seg from "./SegmentedToggle.module.css";
import styles from "./MultiToggle.module.css";
import type { SegmentedOption } from "./SegmentedToggle";

interface Props<T extends string> {
  /** Accessible name for the group, e.g. "Plays". */
  label: string;
  /** Label of the option that means "no filter", pressed when nothing is selected. */
  anyLabel: string;
  options: readonly SegmentedOption<T>[];
  value: readonly T[];
  onChange: (value: T[]) => void;
}

export default function MultiToggle<T extends string>({ label, anyLabel, options, value, onChange }: Props<T>) {
  const toggle = (v: T) =>
    onChange(options.map((o) => o.value).filter((x) => (x === v ? !value.includes(v) : value.includes(x))));
  return (
    <div className={`${seg.group} ${styles.group}`} role="group" aria-label={label}>
      <button
        type="button"
        className={seg.segment}
        aria-pressed={value.length === 0}
        onClick={() => value.length > 0 && onChange([])}
      >
        {anyLabel}
      </button>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`${seg.segment} ${styles.toggle}`}
          aria-pressed={value.includes(o.value)}
          onClick={() => toggle(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

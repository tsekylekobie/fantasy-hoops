"use client";

// One control for a set of mutually exclusive options (position, games range,
// per game / totals). The options sit joined in a single pill so it's clear
// which buttons belong together.
import styles from "./SegmentedToggle.module.css";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  /** Accessible name for the group, e.g. "Position". */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

export default function SegmentedToggle<T extends string>({ label, options, value, onChange }: Props<T>) {
  return (
    <div className={styles.group} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={styles.segment}
          aria-pressed={o.value === value}
          onClick={() => o.value !== value && onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

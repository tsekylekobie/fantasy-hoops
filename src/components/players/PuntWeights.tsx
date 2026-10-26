"use client";

import { CATEGORIES, DEFAULT_WEIGHTS, MAX_WEIGHT, type Category, type CategoryWeights } from "@/lib/types";
import styles from "./PuntWeights.module.css";

const LABELS: Record<Category, string> = {
  fgPct: "FG%", ftPct: "FT%", fg3m: "3PM", pts: "PTS", reb: "REB", ast: "AST", stl: "STL", blk: "BLK", tov: "TO",
};

export function isDefaultWeights(w: CategoryWeights): boolean {
  return CATEGORIES.every((c) => w[c] === DEFAULT_WEIGHTS[c]);
}

/** "1,1,1,1,1,1,1,1,0.25" for GET /api/players?weights= */
export function weightsParam(w: CategoryWeights): string {
  return CATEGORIES.map((c) => String(w[c])).join(",");
}

interface Props {
  weights: CategoryWeights;
  onChange: (weights: CategoryWeights) => void;
  /** Signed out: changes apply but aren't saved. */
  signedIn: boolean;
  /** Last save failed. */
  saveError: string | null;
}

/** One slider per category: 0 ignores it (a punt), 1 counts it fully. Feeds the Value column and rank. */
export default function PuntWeights({ weights, onChange, signedIn, saveError }: Props) {
  return (
    <section className={styles.panel} aria-label="Punt weights">
      <div className={styles.grid}>
        {CATEGORIES.map((c) => (
          <label key={c} className={`${styles.cat} ${weights[c] === 0 ? styles.punted : ""}`}>
            <span className={styles.head}>
              <span className={styles.label}>{LABELS[c]}</span>
              <span className={styles.num}>{weights[c] === 0 ? "Punt" : weights[c].toFixed(2)}</span>
            </span>
            <input
              type="range"
              min={0}
              max={MAX_WEIGHT}
              step={0.05}
              value={weights[c]}
              aria-label={`${LABELS[c]} weight`}
              aria-valuetext={weights[c] === 0 ? "0, ignored" : weights[c].toFixed(2)}
              onChange={(e) => onChange({ ...weights, [c]: Math.round(Number(e.target.value) * 100) / 100 })}
            />
          </label>
        ))}
      </div>
      <div className={styles.footer}>
        <span className={saveError ? styles.error : undefined} aria-live="polite">
          {saveError
            ? `Couldn’t save: ${saveError}`
            : `0 ignores a category, 1 is the default (TO counts 0.25). ${signedIn ? "Saved to your account." : "Sign in to save them."}`}
        </span>
        <button
          type="button"
          className={styles.reset}
          disabled={isDefaultWeights(weights)}
          onClick={() => onChange({ ...DEFAULT_WEIGHTS })}
        >
          Reset to defaults
        </button>
      </div>
    </section>
  );
}

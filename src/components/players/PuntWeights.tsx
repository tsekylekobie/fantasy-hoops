"use client";

import { toWeights } from "@/lib/queries/params";
import { CATEGORIES, DEFAULT_WEIGHTS, MAX_WEIGHT, type Category, type CategoryWeights } from "@/lib/types";
import styles from "./PuntWeights.module.css";

const LABELS: Record<Category, string> = {
  fgPct: "FG%", ftPct: "FT%", fg3m: "3PM", pts: "PTS", reb: "REB", ast: "AST", stl: "STL", blk: "BLK", tov: "TO",
};

/** Sliders move in tenths. Weights off the grid (saved before TO's default became 0.3, or from a URL) stay until moved. */
const STEP = 0.1;
const CACHE_KEY = "fantasy-hoops:punt-weights";

/** The defaults before TO moved to 0.3. A cached copy of exactly these was never customized (see migration 0016). */
const OLD_DEFAULT_WEIGHTS: CategoryWeights = { ...DEFAULT_WEIGHTS, tov: 0.25 };

/** This browser's copy of the weights; null when there is none, it's the old defaults, it's unreadable or storage is blocked. */
export function readCachedWeights(): CategoryWeights | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    const w = raw ? toWeights(JSON.parse(raw)) : null;
    return w && CATEGORIES.every((c) => w[c] === OLD_DEFAULT_WEIGHTS[c]) ? null : w;
  } catch {
    return null;
  }
}

export function writeCachedWeights(w: CategoryWeights): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(w));
  } catch {
    // Storage blocked or full: the weights still apply to this visit.
  }
}

/** "1.0", "0.3", and "0.25" for a weight off the tenths. */
function fmtWeight(w: number): string {
  return Number.isInteger(Math.round(w * 100) / 10) ? w.toFixed(1) : w.toFixed(2);
}

export function isDefaultWeights(w: CategoryWeights): boolean {
  return CATEGORIES.every((c) => w[c] === DEFAULT_WEIGHTS[c]);
}

/** "1,1,1,1,1,1,1,1,0.3" for GET /api/players?weights= */
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
              <span className={styles.num}>{weights[c] === 0 ? "Punt" : fmtWeight(weights[c])}</span>
            </span>
            <input
              type="range"
              min={0}
              max={MAX_WEIGHT}
              step={STEP}
              value={weights[c]}
              aria-label={`${LABELS[c]} weight`}
              aria-valuetext={weights[c] === 0 ? "0, ignored" : fmtWeight(weights[c])}
              onChange={(e) => onChange({ ...weights, [c]: Math.round(Number(e.target.value) * 10) / 10 })}
              onKeyDown={(e) => {
                // Off the grid (e.g. an older saved 0.25), the browser would snap to 0.3 before stepping: step to the neighbor instead.
                const tenths = weights[c] * 10;
                const dir = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
                if (dir === 0 || Math.abs(tenths - Math.round(tenths)) < 1e-9) return;
                e.preventDefault();
                onChange({ ...weights, [c]: (dir > 0 ? Math.ceil(tenths) : Math.floor(tenths)) / 10 });
              }}
            />
          </label>
        ))}
      </div>
      <div className={styles.footer}>
        <span className={saveError ? styles.error : undefined} aria-live="polite">
          {saveError
            ? `Couldn’t save: ${saveError}`
            : `0 ignores a category, 1 is the default (TO counts 0.3). ${signedIn ? "Saved to your account and this browser." : "Saved in this browser; sign in to keep them on every device."}`}
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

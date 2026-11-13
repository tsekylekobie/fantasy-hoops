"use client";

import { toWeights } from "@/lib/queries/params";
import {
  CATEGORIES, DEFAULT_WEIGHTS, PUNTABLE_CATEGORIES, puntedCategories, type Category, type CategoryWeights,
} from "@/lib/types";
import styles from "./PuntWeights.module.css";

const LABELS: Record<Category, string> = {
  fgPct: "FG%", ftPct: "FT%", fg3m: "3PM", pts: "PTS", reb: "REB", ast: "AST", stl: "STL", blk: "BLK", tov: "TO",
};

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
    // Storage blocked or full: the punts still apply to this visit.
  }
}

/** Nothing punted (TO's stored weight doesn't matter). */
export function isDefaultWeights(w: CategoryWeights): boolean {
  return puntedCategories(w).length === 0;
}

/** "FT%, AST" for the toolbar button; "" with no punts. */
export function puntsSummary(w: CategoryWeights): string {
  return puntedCategories(w).map((c) => LABELS[c]).join(", ");
}

/** "1,1,1,1,1,1,1,1,0.3" for GET /api/players?weights= */
export function weightsParam(w: CategoryWeights): string {
  return CATEGORIES.map((c) => String(w[c])).join(",");
}

interface Props {
  weights: CategoryWeights;
  onChange: (weights: CategoryWeights) => void;
  /** Last save failed. */
  saveError: string | null;
}

/**
 * One punt checkbox per category but TO (DURANT H2H never counts it): a checked category is left out of the Value
 * column and rank (stored as weight 0; unchecked is 1). Shading isn't affected.
 */
export default function PuntWeights({ weights, onChange, saveError }: Props) {
  return (
    <section className={styles.panel} aria-label="Punt categories">
      <div className={styles.grid}>
        {PUNTABLE_CATEGORIES.map((c) => (
          <label key={c} className={styles.check}>
            <input
              type="checkbox"
              checked={weights[c] === 0}
              onChange={(e) => onChange({ ...weights, [c]: e.target.checked ? 0 : 1 })}
            />
            {LABELS[c]}
          </label>
        ))}
        <button
          type="button"
          className={styles.reset}
          disabled={isDefaultWeights(weights)}
          onClick={() => onChange({ ...DEFAULT_WEIGHTS })}
        >
          Clear punts
        </button>
      </div>
      {saveError && <p className={styles.error} aria-live="polite">Couldn’t save: {saveError}</p>}
    </section>
  );
}

"use client";

import { useState } from "react";
import type { WatchResponse } from "@/lib/types";
import styles from "./WatchStar.module.css";

/**
 * The watchlist star (PUT/DELETE /api/players/:id/watch). Controlled: the
 * parent owns `watched`; a click flips it right away through `onChange` and
 * flips it back if the save fails. Render only when signed in.
 */
export default function WatchStar({
  playerId, name, watched, onChange, size = "row", className,
}: {
  playerId: number;
  /** The player's name, for the label. */
  name: string;
  watched: boolean;
  onChange: (playerId: number, watched: boolean) => void;
  size?: "row" | "modal";
  className?: string;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (saving) return;
    const next = !watched;
    setSaving(true);
    setError(null);
    onChange(playerId, next);
    try {
      const res = await fetch(`/api/players/${playerId}/watch`, { method: next ? "PUT" : "DELETE" });
      const body = (await res.json().catch(() => null)) as (WatchResponse & { error?: string }) | null;
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status}).`);
    } catch (err) {
      onChange(playerId, !next);
      setError(err instanceof Error && err.message !== "Failed to fetch" ? err.message : "Network error.");
    } finally {
      setSaving(false);
    }
  };

  const label = `${watched ? "Unwatch" : "Watch"} ${name}`;
  return (
    <button
      type="button"
      className={`${styles.star} ${size === "modal" ? styles.modal : ""} ${watched ? styles.on : ""} ${className ?? ""}`}
      aria-label={label}
      aria-pressed={watched}
      aria-busy={saving}
      title={error ? `Couldn’t save: ${error}` : watched ? "On your watchlist" : "Add to watchlist"}
      onClick={toggle}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 1.8l2.47 5.2 5.7.68-4.2 3.9 1.1 5.63L10 14.45l-5.07 2.76 1.1-5.63-4.2-3.9 5.7-.68z" />
      </svg>
    </button>
  );
}

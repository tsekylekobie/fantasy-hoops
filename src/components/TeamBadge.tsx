"use client";

// A fantasy team's badge: its logo when it has one, else the abbreviation
// (the same way Avatar falls back to initials). Renders an <i> so each spot's
// existing badge styles (size, circle, colors) keep applying; the logo just
// fills that circle.
import { useEffect, useRef, useState } from "react";
import type { FantasyTeamSummary } from "@/lib/types";
import styles from "./TeamBadge.module.css";

export interface TeamBadgeProps {
  team: Pick<FantasyTeamSummary, "abbreviation" | "logoUrl">;
  className?: string;
}

export default function TeamBadge({ team, className }: TeamBadgeProps) {
  // Keyed by URL so a new logo (or another team in a reused row) starts over.
  const [failed, setFailed] = useState<string | null>(null);
  const src = team.logoUrl && failed !== team.logoUrl ? team.logoUrl : null;
  const imgRef = useRef<HTMLImageElement>(null);

  // A server-rendered <img> can fail before React hydrates and attaches onError.
  useEffect(() => {
    const img = imgRef.current;
    if (src && img?.complete && img.naturalWidth === 0) setFailed(src);
  }, [src]);

  return (
    <i aria-hidden="true" className={[className, src && styles.logo].filter(Boolean).join(" ") || undefined}>
      {src ? (
        <img ref={imgRef} className={styles.img} src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(src)} />
      ) : (
        team.abbreviation
      )}
    </i>
  );
}

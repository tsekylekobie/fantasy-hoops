"use client";

// Player headshot from the NBA CDN, falling back to an initials circle when
// the player has no NBA person id or the image fails to load. The CDN is not
// an official API (PLAN.md), so the fallback is the normal path, not an edge case.
import { useEffect, useRef, useState } from "react";
import type { PlayerSummary } from "@/lib/types";
import styles from "./Avatar.module.css";

export interface AvatarProps {
  player: Pick<PlayerSummary, "firstName" | "lastName" | "nbaPersonId">;
  /** Diameter in px: 40 in the table, 60 in the modal. */
  size?: number;
}

export function initials(firstName: string, lastName: string): string {
  return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
}

export function headshotUrl(nbaPersonId: number, size: number): string {
  const dims = size > 80 ? "1040x760" : "260x190";
  return `https://cdn.nba.com/headshots/nba/latest/${dims}/${nbaPersonId}.png`;
}

type Status = "loading" | "loaded" | "error";

export default function Avatar({ player, size = 40 }: AvatarProps) {
  const id = player.nbaPersonId;
  const src = id != null ? headshotUrl(id, size) : null;
  // Keyed by src so a new player (e.g. reused table row) starts over.
  const [state, setState] = useState<{ src: string | null; status: Status }>({ src, status: "loading" });
  const status: Status = state.src === src ? state.status : "loading";
  const imgRef = useRef<HTMLImageElement>(null);

  // A server-rendered <img> can finish (or fail) before React hydrates and
  // attaches onLoad/onError, so check its state once mounted.
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !img.complete) return;
    setState({ src, status: img.naturalWidth > 0 ? "loaded" : "error" });
  }, [src]);

  const showImg = src != null && status !== "error";
  return (
    <span
      aria-hidden="true"
      className={styles.avatar}
      style={{ width: size, height: size, fontSize: Math.round(size / 3) }}
    >
      <span className={styles.initials} hidden={showImg && status === "loaded"}>
        {initials(player.firstName, player.lastName)}
      </span>
      {showImg && (
        // Plain <img>: the CDN already serves the two sizes we need, and
        // next/image would proxy every headshot through our server.
        <img
          ref={imgRef}
          className={`${styles.img} ${status === "loaded" ? styles.loaded : ""}`}
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setState({ src, status: "loaded" })}
          onError={() => setState({ src, status: "error" })}
        />
      )}
    </span>
  );
}

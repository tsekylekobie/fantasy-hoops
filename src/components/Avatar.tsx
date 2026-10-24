// Initials-only stub. The headshot work (PLAN.md step 6) adds the NBA CDN
// image with a fallback to these initials; keep this props interface.
import type { PlayerSummary } from "@/lib/types";

export interface AvatarProps {
  player: Pick<PlayerSummary, "firstName" | "lastName" | "nbaPersonId">;
  /** Diameter in px: 40 in the table, 60 in the modal. */
  size?: number;
}

export function initials(firstName: string, lastName: string): string {
  return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
}

export default function Avatar({ player, size = 40 }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--accent-soft)",
        color: "var(--accent-ink)",
        fontWeight: 600,
        fontSize: Math.round(size / 3),
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "none",
      }}
    >
      {initials(player.firstName, player.lastName)}
    </span>
  );
}

// Which injury report changes are worth a push notification, and what it says.
// Pure (tested in injuryAlerts.test.ts); sending is src/lib/push/send.ts.
import { parseInjuryDescription } from "../queries/injuries";

/**
 * How bad a status is, 0 = healthy (off the report or "Available"). A status
 * the provider adds later ranks with Day-To-Day, so a move onto it from
 * healthy still counts as a downgrade.
 */
const SEVERITY: Record<string, number> = {
  Probable: 1,
  Questionable: 2,
  "Day-To-Day": 3,
  Doubtful: 4,
  Out: 5,
};

export function injurySeverity(status: string | null): number {
  if (!status || status === "Available") return 0;
  return SEVERITY[status] ?? SEVERITY["Day-To-Day"];
}

/** True when the new status is worse than the old one (e.g. Questionable to Out). */
export function isDowngrade(from: string | null, to: string | null): boolean {
  return injurySeverity(to) > injurySeverity(from);
}

/** True when an injured player is healthy again (off the report or "Available"). */
export function isCleared(from: string | null, to: string | null): boolean {
  return injurySeverity(from) > 0 && injurySeverity(to) === 0;
}

/**
 * Whether a change is worth a notification: any downgrade, or an injured
 * player cleared. Smaller upgrades (Out to Questionable) aren't.
 */
export function shouldAlert(from: string | null, to: string | null): boolean {
  return isDowngrade(from, to) || isCleared(from, to);
}

export interface InjuryAlertInput {
  playerId: number;
  playerName: string;
  /** The previous status; null when he wasn't on the report. */
  from: string | null;
  /** The new status; null when he left the report. */
  to: string | null;
  returnDate: string | null;
  description: string | null;
  teamName: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Same tag replaces the earlier notification about this player. */
  tag: string;
  /** Page opened when the notification is tapped. */
  url: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 20" from yyyy-mm-dd. */
function shortDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

function statusLabel(status: string | null): string {
  return !status || status === "Available" ? "Healthy" : status;
}

export function injuryAlert(a: InjuryAlertInput): PushMessage {
  const tag = `injury-${a.playerId}`;
  if (injurySeverity(a.to) === 0) {
    return {
      title: `${a.playerName}: ${statusLabel(a.from)} → ${statusLabel(a.to)}`,
      body: `Off the injury report. On ${a.teamName}.`,
      tag,
      url: "/my-team",
    };
  }
  const { injury } = parseInjuryDescription(a.description);
  const parts = [injury, a.returnDate ? `est. return ${shortDate(a.returnDate)}` : null].filter(Boolean);
  return {
    title: `${a.playerName}: ${statusLabel(a.from)} → ${a.to}`,
    body: `${parts.length ? `${parts.join(", ")}. ` : ""}On ${a.teamName}.`,
    tag,
    url: "/my-team",
  };
}

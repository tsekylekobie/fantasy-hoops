// A fantasy team's name (or abbreviation) as a link to its page: /my-team for
// the signed-in manager's own team, else /team/<id>. Use it wherever a team is
// named. Inside a row that is itself a link (a scoreboard pairing), make the
// row's link a cover (`::after` over the row) instead of nesting links: this
// link sits above it (position: relative; z-index: 1).
import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./TeamLink.module.css";

export const teamHref = (teamId: number, myTeamId: number | null | undefined) =>
  teamId === myTeamId ? "/my-team" : `/team/${teamId}`;

export default function TeamLink({
  team, myTeamId, className, children,
}: {
  team: { id: number; name: string };
  myTeamId: number | null | undefined;
  className?: string;
  /** Defaults to the team's name. */
  children?: ReactNode;
}) {
  return (
    <Link className={className ? `${styles.link} ${className}` : styles.link} href={teamHref(team.id, myTeamId)}>
      {children ?? team.name}
    </Link>
  );
}

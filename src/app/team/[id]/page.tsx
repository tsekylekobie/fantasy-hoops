import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { SESSION_COOKIE } from "@/lib/auth/config";
import { getSession } from "@/lib/auth/session";
import { pool } from "@/lib/db";
import { getTeamById } from "@/lib/queries/teams";
import { CURRENT_SEASON } from "@/lib/types";
import MyTeam from "@/components/my-team/MyTeam";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

async function load(params: Props["params"]) {
  const id = Number((await params).id);
  return Number.isInteger(id) && id > 0 ? getTeamById(pool, id, CURRENT_SEASON) : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const team = await load(params);
  return { title: `${team?.teamName ?? "Team"} · Fantasy Hoops` };
}

// Another manager's team, read-only. Your own team is /my-team, where it can be edited.
export default async function TeamPage({ params }: Props) {
  const team = await load(params);
  if (!team) notFound();
  const session = await getSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (session && team.ownerUserId === session.user.id) redirect("/my-team");
  // The commissioner may edit any team's name and logo.
  const { rows: [league] } = await pool.query<{ commissioner_user_id: number | null }>(
    `SELECT commissioner_user_id::int FROM leagues WHERE id = $1`,
    [team.leagueId],
  );
  const isCommissioner = session !== null && league?.commissioner_user_id === session.user.id;
  return (
    <Suspense fallback={null}>
      <MyTeam teamId={team.teamId} canEditProfile={isCommissioner} />
    </Suspense>
  );
}

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { currentSession, requireSignedInPage } from "@/lib/auth/viewer";
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
  // Team names are league data: signed out, don't put one in the title.
  const team = (await currentSession()) ? await load(params) : null;
  return { title: `${team?.teamName ?? "Team"} · Fantasy Hoops` };
}

// Another manager's team, read-only. Your own team is /my-team, where it can be edited. Signed in only.
export default async function TeamPage({ params }: Props) {
  const session = await requireSignedInPage();
  const team = await load(params);
  if (!team) notFound();
  if (team.ownerUserId === session.user.id) redirect("/my-team");
  // The commissioner may edit any team's name and logo.
  const { rows: [league] } = await pool.query<{ commissioner_user_id: number | null }>(
    `SELECT commissioner_user_id::int FROM leagues WHERE id = $1`,
    [team.leagueId],
  );
  const isCommissioner = league?.commissioner_user_id === session.user.id;
  return (
    <Suspense fallback={null}>
      <MyTeam teamId={team.teamId} canEditProfile={isCommissioner} />
    </Suspense>
  );
}

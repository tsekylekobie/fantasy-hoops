import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { currentSession, requireSignedInPage } from "@/lib/auth/viewer";
import { pool } from "@/lib/db";
import { getTeamById } from "@/lib/queries/teams";
import { CURRENT_SEASON } from "@/lib/types";
import TradeBuilder from "@/components/trades/TradeBuilder";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

async function load(params: Props["params"]) {
  const id = Number((await params).id);
  return Number.isInteger(id) && id > 0 ? getTeamById(pool, id, CURRENT_SEASON) : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const team = (await currentSession()) ? await load(params) : null;
  return { title: `Trade with ${team?.teamName ?? "a team"} · Fantasy Hoops` };
}

// Propose a trade to team [id]. The rosters load client-side from /api/trades/builder.
export default async function TradePage({ params }: Props) {
  const session = await requireSignedInPage();
  const team = await load(params);
  if (!team) notFound();
  if (team.ownerUserId === session.user.id) redirect("/my-team");
  return <TradeBuilder partnerId={team.teamId} />;
}

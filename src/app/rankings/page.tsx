import type { Metadata } from "next";
import { requireSignedInPage } from "@/lib/auth/viewer";
import { pool } from "@/lib/db";
import { getRankings } from "@/lib/queries/rankings";
import { CURRENT_SEASON } from "@/lib/types";
import RankingsView from "@/components/rankings/RankingsView";

export const metadata: Metadata = { title: "Rankings · Fantasy Hoops" };
export const dynamic = "force-dynamic";

const positiveInt = (raw: string | undefined) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Server-rendered from our DB. ?view=season adds up the regular season (default
// one week), ?week=N picks the week (default this week), ?team=ID the team in
// Versus the league (default yours). Signed in only (league data is private).
export default async function RankingsPage({ searchParams }: {
  searchParams: Promise<{ view?: string; week?: string; team?: string }>;
}) {
  const { view, week, team } = await searchParams;
  const session = await requireSignedInPage();
  const teamId = positiveInt(team);
  const data = await getRankings(pool, CURRENT_SEASON, session.user.id, {
    period: view === "season" ? "season" : "week",
    week: positiveInt(week),
    teamId,
  });
  return <RankingsView data={data} teamParam={teamId} />;
}

import type { Metadata } from "next";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth/config";
import { getSession } from "@/lib/auth/session";
import { pool } from "@/lib/db";
import { getLeagueOverview, getRecentTransactions } from "@/lib/queries/league";
import { CURRENT_SEASON } from "@/lib/types";
import LeagueView from "@/components/league/LeagueView";
import RecentTransactions from "@/components/league/RecentTransactions";

export const metadata: Metadata = { title: "League · Fantasy Hoops" };
export const dynamic = "force-dynamic";

// Server-rendered from our DB: standings, this week's scoreboard and recent transactions.
export default async function LeaguePage() {
  const session = await getSession((await cookies()).get(SESSION_COOKIE)?.value);
  const [data, transactions] = await Promise.all([
    getLeagueOverview(pool, CURRENT_SEASON, session?.user.id ?? null),
    getRecentTransactions(pool, CURRENT_SEASON),
  ]);
  return (
    <LeagueView data={data}>
      <RecentTransactions data={transactions} myTeamId={data?.myTeam?.id ?? null} />
    </LeagueView>
  );
}

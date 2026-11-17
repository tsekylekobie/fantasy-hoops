import type { Metadata } from "next";
import { currentSession } from "@/lib/auth/viewer";
import { pool } from "@/lib/db";
import { getLeagueOverview, getRecentTransactions } from "@/lib/queries/league";
import { getWaiverOrder } from "@/lib/queries/waivers";
import { CURRENT_SEASON } from "@/lib/types";
import LeagueView, { SignedOutLeague } from "@/components/league/LeagueView";
import RecentTransactions from "@/components/league/RecentTransactions";
import WaiverOrder from "@/components/waivers/WaiverOrder";
import waiverStyles from "@/components/waivers/WaiverOrder.module.css";

export const metadata: Metadata = { title: "League · Fantasy Hoops" };
export const dynamic = "force-dynamic";

const positiveInt = (raw: string | undefined) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Server-rendered from our DB: standings, a week's scoreboard (?week=N, default this week), the 5 latest
// transactions (all of them at /league/transactions) and the waiver order.
// Read-only: the league is run on Yahoo and mirrored here. The header links to /league/settings (League rules).
// League data is private: signed out, the page only asks to sign in.
export default async function LeaguePage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const { week } = await searchParams;
  const session = await currentSession();
  if (!session) return <SignedOutLeague />;
  const userId = session.user.id;
  const [data, transactions, waivers] = await Promise.all([
    getLeagueOverview(pool, CURRENT_SEASON, userId, positiveInt(week)),
    getRecentTransactions(pool, CURRENT_SEASON, { limit: 5 }),
    getWaiverOrder(pool, CURRENT_SEASON),
  ]);
  const myTeamId = data?.myTeam?.id ?? null;
  return (
    <LeagueView data={data}>
      <div className={waiverStyles.below}>
        <RecentTransactions data={transactions} myTeamId={myTeamId} viewAllHref="/league/transactions" />
        <WaiverOrder data={waivers} myTeamId={myTeamId} />
      </div>
    </LeagueView>
  );
}

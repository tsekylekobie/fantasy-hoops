import type { Metadata } from "next";
import { currentSession } from "@/lib/auth/viewer";
import { pool } from "@/lib/db";
import { getLeagueOverview, getRecentTransactions } from "@/lib/queries/league";
import { getLeagueSettings } from "@/lib/queries/settings";
import { getWaiverOrder } from "@/lib/queries/waivers";
import { CURRENT_SEASON } from "@/lib/types";
import LeagueView, { SignedOutLeague } from "@/components/league/LeagueView";
import RecentTransactions from "@/components/league/RecentTransactions";
import WaiverOrder from "@/components/waivers/WaiverOrder";
import waiverStyles from "@/components/waivers/WaiverOrder.module.css";

export const metadata: Metadata = { title: "League · Fantasy Hoops" };
export const dynamic = "force-dynamic";

// Server-rendered from our DB: standings, this week's scoreboard, recent transactions and the waiver order.
// The commissioner also gets links to /league/settings (header, and Edit on the waiver rules).
// League data is private: signed out, the page only asks to sign in.
export default async function LeaguePage() {
  const session = await currentSession();
  if (!session) return <SignedOutLeague />;
  const userId = session.user.id;
  const [data, transactions, waivers, settings] = await Promise.all([
    getLeagueOverview(pool, CURRENT_SEASON, userId),
    getRecentTransactions(pool, CURRENT_SEASON),
    getWaiverOrder(pool, CURRENT_SEASON),
    getLeagueSettings(pool, CURRENT_SEASON, userId),
  ]);
  const myTeamId = data?.myTeam?.id ?? null;
  return (
    <LeagueView data={data} isCommissioner={settings?.isCommissioner ?? false}>
      <div className={waiverStyles.below}>
        <RecentTransactions data={transactions} myTeamId={myTeamId} />
        <WaiverOrder data={waivers} myTeamId={myTeamId} canEdit={settings?.isCommissioner ?? false} />
      </div>
    </LeagueView>
  );
}

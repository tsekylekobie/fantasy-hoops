import type { Metadata } from "next";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth/config";
import { getSession } from "@/lib/auth/session";
import { pool } from "@/lib/db";
import { getLeagueOverview, getRecentTransactions } from "@/lib/queries/league";
import { getLeagueSettings } from "@/lib/queries/settings";
import { getWaiverOrder } from "@/lib/queries/waivers";
import { CURRENT_SEASON } from "@/lib/types";
import LeagueView from "@/components/league/LeagueView";
import RecentTransactions from "@/components/league/RecentTransactions";
import WaiverOrder from "@/components/waivers/WaiverOrder";
import waiverStyles from "@/components/waivers/WaiverOrder.module.css";

export const metadata: Metadata = { title: "League · Fantasy Hoops" };
export const dynamic = "force-dynamic";

// Server-rendered from our DB: standings, this week's scoreboard, recent transactions and the waiver order.
// The commissioner also gets links to /league/settings (header, and Edit on the waiver rules).
export default async function LeaguePage() {
  const session = await getSession((await cookies()).get(SESSION_COOKIE)?.value);
  const userId = session?.user.id ?? null;
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

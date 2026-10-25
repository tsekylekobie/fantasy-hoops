import type { Metadata } from "next";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth/config";
import { getSession } from "@/lib/auth/session";
import { pool } from "@/lib/db";
import { getLeagueOverview } from "@/lib/queries/league";
import { CURRENT_SEASON } from "@/lib/types";
import LeagueView from "@/components/league/LeagueView";

export const metadata: Metadata = { title: "League · Fantasy Hoops" };
export const dynamic = "force-dynamic";

// Server-rendered from our DB: standings and this week's scoreboard.
export default async function LeaguePage() {
  const session = await getSession((await cookies()).get(SESSION_COOKIE)?.value);
  const data = await getLeagueOverview(pool, CURRENT_SEASON, session?.user.id ?? null);
  return <LeagueView data={data} />;
}

import type { Metadata } from "next";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth/config";
import { getSession } from "@/lib/auth/session";
import { pool } from "@/lib/db";
import { getMatchupWeek } from "@/lib/queries/matchups";
import { CURRENT_SEASON } from "@/lib/types";
import MatchupView from "@/components/matchup/MatchupView";

export const metadata: Metadata = { title: "Matchup · Fantasy Hoops" };
export const dynamic = "force-dynamic";

// Server-rendered from our DB. ?week=N picks a week; the default is this week.
export default async function MatchupPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const { week: rawWeek } = await searchParams;
  const n = Number(rawWeek);
  const week = Number.isInteger(n) && n > 0 ? n : null;
  const session = await getSession((await cookies()).get(SESSION_COOKIE)?.value);
  const data = await getMatchupWeek(pool, CURRENT_SEASON, week, session?.user.id ?? null);
  return <MatchupView data={data} signedIn={session !== null} />;
}

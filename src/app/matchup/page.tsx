import type { Metadata } from "next";
import { requireSignedInPage } from "@/lib/auth/viewer";
import { pool } from "@/lib/db";
import { getMatchupWeek } from "@/lib/queries/matchups";
import { CURRENT_SEASON } from "@/lib/types";
import MatchupView from "@/components/matchup/MatchupView";

export const metadata: Metadata = { title: "Matchup · Fantasy Hoops" };
export const dynamic = "force-dynamic";

const positiveInt = (raw: string | undefined) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Server-rendered from our DB. ?week=N picks a week (default this week),
// ?team=ID another team's matchup (default yours), ?stats=yyyy-mm-dd|week the
// rosters' stats (default today while the week is live, else week totals),
// ?view=projected projected week totals instead. Signed in only (league data is private).
export default async function MatchupPage({ searchParams }: {
  searchParams: Promise<{ week?: string; team?: string; stats?: string; view?: string }>;
}) {
  const { week, team, stats, view } = await searchParams;
  const session = await requireSignedInPage();
  const data = await getMatchupWeek(pool, CURRENT_SEASON, positiveInt(week), session.user.id, {
    teamId: positiveInt(team),
    stats: stats ?? null,
    projected: view === "projected",
  });
  return <MatchupView data={data} signedIn />;
}

import type { Metadata } from "next";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth/config";
import { getSession } from "@/lib/auth/session";
import { pool } from "@/lib/db";
import { getBoxScores } from "@/lib/queries/boxScores";
import { getWeights } from "@/lib/queries/weights";
import { CURRENT_SEASON, DEFAULT_WEIGHTS } from "@/lib/types";
import BoxScoresView from "@/components/box-scores/BoxScoresView";

export const metadata: Metadata = { title: "Box scores · Fantasy Hoops" };
export const dynamic = "force-dynamic";

// Server-rendered from our DB. ?date=yyyy-mm-dd picks the date (default today
// in the league's time zone), ?game=<id> the game to open (e.g. from a player's game log).
// Values use your saved punt weights.
export default async function BoxScoresPage({ searchParams }: { searchParams: Promise<{ date?: string; game?: string }> }) {
  const { date, game } = await searchParams;
  const session = await getSession((await cookies()).get(SESSION_COOKIE)?.value);
  const userId = session?.user.id ?? null;
  const weights = userId !== null ? await getWeights(pool, userId) : DEFAULT_WEIGHTS;
  const data = await getBoxScores(pool, CURRENT_SEASON, userId, date ?? null, weights);
  const gameId = Number(game);
  const initialGame = Number.isInteger(gameId) && data.games.some((g) => g.id === gameId) ? gameId : null;
  return <BoxScoresView key={`${data.date}:${initialGame ?? ""}`} data={data} initialGame={initialGame} />;
}

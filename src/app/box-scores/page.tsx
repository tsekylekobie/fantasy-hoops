import type { Metadata } from "next";
import { currentSession } from "@/lib/auth/viewer";
import { pool } from "@/lib/db";
import { getBoxScores } from "@/lib/queries/boxScores";
import { getWeights } from "@/lib/queries/weights";
import { CURRENT_SEASON, DEFAULT_WEIGHTS, type BoxScoreTeam, type BoxScoresResponse } from "@/lib/types";
import BoxScoresView from "@/components/box-scores/BoxScoresView";

export const metadata: Metadata = { title: "Box scores · Fantasy Hoops" };
export const dynamic = "force-dynamic";

// Server-rendered from our DB. ?date=yyyy-mm-dd picks the date (default today
// in the league's time zone), ?game=<id> the game to open (e.g. from a player's game log).
// Values use your saved punt weights. Box scores are public; signed out, players carry no owner or
// waiver status (league data is private).
export default async function BoxScoresPage({ searchParams }: { searchParams: Promise<{ date?: string; game?: string }> }) {
  const { date, game } = await searchParams;
  const session = await currentSession();
  const userId = session?.user.id ?? null;
  const weights = userId !== null ? await getWeights(pool, userId) : DEFAULT_WEIGHTS;
  let data = await getBoxScores(pool, CURRENT_SEASON, userId, date ?? null, weights);
  if (userId === null) data = withoutLeague(data);
  const gameId = Number(game);
  const initialGame = Number.isInteger(gameId) && data.games.some((g) => g.id === gameId) ? gameId : null;
  return <BoxScoresView key={`${data.date}:${initialGame ?? ""}`} data={data} initialGame={initialGame} />;
}

/** The box scores without league info: no owners or waiver status. */
function withoutLeague(data: BoxScoresResponse): BoxScoresResponse {
  const strip = (t: BoxScoreTeam): BoxScoreTeam => ({ ...t, players: t.players.map((p) => ({ ...p, owner: null, waiver: null })) });
  return { ...data, myTeamId: null, games: data.games.map((g) => ({ ...g, away: strip(g.away), home: strip(g.home), mine: [] })) };
}

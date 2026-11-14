// GET /api/players/:id?season=2026&method=durant|9cat (ranks by DURANT H2H or plain 9CAT; omitted = durant)
// Ranks use the signed-in user's punt weights (the defaults when signed out). League data is private:
// signed out, there is no owner, waiver status, fantasy week or transaction history.
// Contract: PlayerDetailResponse in src/lib/types.ts.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { BadRequest, parsePlayerId, parseRankMethod, parseSeason } from "@/lib/queries/params";
import { getPlayerTransactions } from "@/lib/queries/league";
import { getPlayerWeek } from "@/lib/queries/lineup";
import { getPlayerDetail } from "@/lib/queries/players";
import { getWeights } from "@/lib/queries/weights";
import { DEFAULT_WEIGHTS, type PlayerDetailResponse, type RankMethod } from "@/lib/types";
import { sessionUserId } from "../../team/lineup/shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let id: number;
  let season: number;
  let method: RankMethod;
  try {
    id = parsePlayerId((await params).id);
    const search = new URL(req.url).searchParams;
    season = parseSeason(search);
    method = parseRankMethod(search);
  } catch (err) {
    if (err instanceof BadRequest) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  try {
    const userId = await sessionUserId();
    const weights = userId === null ? DEFAULT_WEIGHTS : await getWeights(pool, userId);
    const signedIn = userId !== null;
    const [detail, thisWeek, transactions] = await Promise.all([
      getPlayerDetail(pool, id, season, userId, weights, method),
      signedIn ? getPlayerWeek(pool, id, season) : null,
      signedIn ? getPlayerTransactions(pool, id, season) : [],
    ]);
    if (!detail) return NextResponse.json({ error: "Player not found" }, { status: 404 });
    const body: PlayerDetailResponse = signedIn
      ? { ...detail, thisWeek, transactions }
      : { ...detail, owner: null, waiver: null, thisWeek: null, transactions: [] };
    // No caching: owners change with every add and drop; private: the star is per user.
    return NextResponse.json(body, { headers: { "Cache-Control": "private, no-cache" } });
  } catch (err) {
    console.error(`GET /api/players/${id} failed`, err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

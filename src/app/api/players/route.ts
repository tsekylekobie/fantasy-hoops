// GET /api/players?season=2026&mode=avg&scope=fa&q=&pos=all&plays=tomorrow,in2&waivers=clears&page=1&perPage=50
// Contract: PlayersResponse in src/lib/types.ts. scope=watch is the signed-in user's watchlist (401 signed out).
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { BadRequest, parsePlayersQuery } from "@/lib/queries/params";
import { getPlayers } from "@/lib/queries/players";
import { sessionUserId } from "../team/lineup/shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  let query;
  try {
    query = parsePlayersQuery(new URL(req.url).searchParams);
  } catch (err) {
    if (err instanceof BadRequest) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  try {
    const userId = await sessionUserId();
    if (query.scope === "watch" && userId === null) {
      return NextResponse.json({ error: "Sign in to see your watchlist." }, { status: 401 });
    }
    const body = await getPlayers(pool, query, userId);
    // No caching: owners change with every add and drop; private: the stars are per user.
    return NextResponse.json(body, { headers: { "Cache-Control": "private, no-cache" } });
  } catch (err) {
    console.error("GET /api/players failed", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

// GET /api/players?season=2026&mode=avg&scope=fa&q=&pos=all&plays=tomorrow,in2&waivers=clears&page=1&perPage=50
// Contract: PlayersResponse in src/lib/types.ts.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { BadRequest, parsePlayersQuery } from "@/lib/queries/params";
import { getPlayers } from "@/lib/queries/players";

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
    const body = await getPlayers(pool, query);
    // No caching: owners change with every add and drop.
    return NextResponse.json(body, { headers: { "Cache-Control": "no-cache" } });
  } catch (err) {
    console.error("GET /api/players failed", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

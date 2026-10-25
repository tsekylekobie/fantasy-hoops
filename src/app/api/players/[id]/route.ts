// GET /api/players/:id?season=2026
// Contract: PlayerDetailResponse in src/lib/types.ts.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { BadRequest, parsePlayerId, parseSeason } from "@/lib/queries/params";
import { getPlayerDetail } from "@/lib/queries/players";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let id: number;
  let season: number;
  try {
    id = parsePlayerId((await params).id);
    season = parseSeason(new URL(req.url).searchParams);
  } catch (err) {
    if (err instanceof BadRequest) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  try {
    const detail = await getPlayerDetail(pool, id, season);
    if (!detail) return NextResponse.json({ error: "Player not found" }, { status: 404 });
    // No caching: owners change with every add and drop.
    return NextResponse.json(detail, { headers: { "Cache-Control": "no-cache" } });
  } catch (err) {
    console.error(`GET /api/players/${id} failed`, err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

// GET /api/players/:id?season=2026
// Contract: PlayerDetailResponse in src/lib/types.ts.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { BadRequest, parsePlayerId, parseSeason } from "@/lib/queries/params";
import { getPlayerWeek } from "@/lib/queries/lineup";
import { getPlayerDetail } from "@/lib/queries/players";
import type { PlayerDetailResponse } from "@/lib/types";
import { sessionUserId } from "../../team/lineup/shared";

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
    const userId = await sessionUserId();
    const [detail, thisWeek] = await Promise.all([
      getPlayerDetail(pool, id, season, userId),
      getPlayerWeek(pool, id, season),
    ]);
    if (!detail) return NextResponse.json({ error: "Player not found" }, { status: 404 });
    const body: PlayerDetailResponse = { ...detail, thisWeek };
    // No caching: owners change with every add and drop; private: the star is per user.
    return NextResponse.json(body, { headers: { "Cache-Control": "private, no-cache" } });
  } catch (err) {
    console.error(`GET /api/players/${id} failed`, err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

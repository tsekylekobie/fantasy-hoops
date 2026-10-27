// GET /api/players/:id/news
// Contract: PlayerNewsResponse in src/lib/types.ts. Fetched live from ESPN
// (cached in memory), not from our DB: news is only worth showing fresh.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { getPlayerNews } from "@/lib/espn/news";
import { BadRequest, parsePlayerId } from "@/lib/queries/params";
import type { PlayerNewsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let id: number;
  try {
    id = parsePlayerId((await params).id);
  } catch (err) {
    if (err instanceof BadRequest) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  const { rows } = await pool.query<{ first_name: string; last_name: string }>(
    "SELECT first_name, last_name FROM players WHERE id = $1",
    [id],
  );
  if (rows.length === 0) return NextResponse.json({ error: "Player not found" }, { status: 404 });
  try {
    const body: PlayerNewsResponse = { items: await getPlayerNews(`${rows[0].first_name} ${rows[0].last_name}`) };
    return NextResponse.json(body, { headers: { "Cache-Control": "private, max-age=300" } });
  } catch (err) {
    console.error(`GET /api/players/${id}/news failed`, err);
    return NextResponse.json({ error: "News is unavailable right now." }, { status: 502 });
  }
}

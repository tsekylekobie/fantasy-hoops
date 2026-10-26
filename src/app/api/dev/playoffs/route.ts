// POST /api/dev/playoffs?today=yyyy-mm-dd  creates due playoff and toilet bowl
// rounds by hand (local dev only; 404s wherever mock sign-in is off, so never in
// production). `today` (default the league's today) pretends it's that day.
// Responds with what happened. Logic: syncPlayoffs in src/lib/queries/playoffs.ts.
import { NextResponse } from "next/server";
import { mockAuthEnabled } from "@/lib/auth/config";
import { pool } from "@/lib/db";
import { syncPlayoffs } from "@/lib/queries/playoffs";
import { CURRENT_SEASON } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!mockAuthEnabled()) return new NextResponse("Not found", { status: 404 });
  const today = new URL(req.url).searchParams.get("today") ?? undefined;
  if (today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    return NextResponse.json({ error: "today must be yyyy-mm-dd" }, { status: 400 });
  }
  return NextResponse.json(await syncPlayoffs(pool, CURRENT_SEASON, { today }), { headers: { "Cache-Control": "no-store" } });
}

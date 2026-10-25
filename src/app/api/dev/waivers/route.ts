// POST /api/dev/waivers?at=next|now|<ISO time>  runs waivers by hand (local dev only;
// 404s wherever mock sign-in is off, so never in production). `at` (default
// "next") is the time to process as of: "next" runs the next scheduled run now,
// early. A manual run doesn't use up the scheduled one. Responds with the run summary.
import { NextResponse } from "next/server";
import { mockAuthEnabled } from "@/lib/auth/config";
import { pool } from "@/lib/db";
import { processWaivers, resolveRunTime } from "@/lib/queries/waivers";
import { CURRENT_SEASON } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!mockAuthEnabled()) return new NextResponse("Not found", { status: 404 });
  const { rows: [league] } = await pool.query<{ id: number }>(
    `SELECT id::int FROM leagues WHERE season = $1 ORDER BY id DESC LIMIT 1`,
    [CURRENT_SEASON],
  );
  if (!league) return NextResponse.json({ error: "No league this season" }, { status: 404 });
  const asOf = await resolveRunTime(pool, league.id, new URL(req.url).searchParams.get("at") ?? "next");
  if (!asOf) return NextResponse.json({ error: "at must be next, now, or an ISO time" }, { status: 400 });
  const run = await processWaivers(pool, league.id, asOf, { scheduled: false });
  return NextResponse.json(run, { headers: { "Cache-Control": "no-store" } });
}

// POST /api/yahoo/league {leagueKey}  picks which of the connected account's leagues to mirror
// (when it has more than one this season). DELETE /api/yahoo/league  disconnects Yahoo (the
// mirrored league stays; nothing syncs until someone connects again). Commissioner only.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { disconnect, getConnection, setLeagueKey } from "@/lib/yahoo/connection";
import { fetchUserLeagues } from "@/lib/yahoo/sync";
import { NO_STORE, errorResponse, handleError, viewer, yahooStatus } from "../shared";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const v = await viewer();
    if (!v) return errorResponse("Sign in first.", 401);
    if (!v.admin) return errorResponse("Only the commissioner can choose the Yahoo league.", 403);
    if (!(await getConnection(pool))) return errorResponse("Yahoo isn't connected yet.", 409);
    const body = (await req.json().catch(() => null)) as { leagueKey?: unknown } | null;
    const key = typeof body?.leagueKey === "string" ? body.leagueKey : "";
    const leagues = await fetchUserLeagues(pool);
    if (!leagues.some((l) => l.key === key)) return errorResponse("That isn't one of the connected account's leagues this season.", 400);
    await setLeagueKey(pool, key);
    return NextResponse.json(await yahooStatus(true), { headers: NO_STORE });
  } catch (err) {
    return handleError("POST /api/yahoo/league", err);
  }
}

export async function DELETE() {
  try {
    const v = await viewer();
    if (!v) return errorResponse("Sign in first.", 401);
    if (!v.admin) return errorResponse("Only the commissioner can disconnect Yahoo.", 403);
    await disconnect(pool);
    return NextResponse.json(await yahooStatus(true), { headers: NO_STORE });
  } catch (err) {
    return handleError("DELETE /api/yahoo/league", err);
  }
}

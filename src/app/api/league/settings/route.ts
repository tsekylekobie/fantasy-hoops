// GET /api/league/settings  the league's rules (commissioner only)
// PUT /api/league/settings  replace them with a whole LeagueSettings (commissioner only)
// Contract: LeagueSettings and LeagueSettingsResponse in src/lib/types.ts.
// 401 signed out, 403 not the commissioner, 400 bad input, 409 IL slots in use.
// Logic: src/lib/queries/settings.ts.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/config";
import { getSession } from "@/lib/auth/session";
import { pool } from "@/lib/db";
import { getLeagueSettings, updateLeagueSettings } from "@/lib/queries/settings";
import { CURRENT_SEASON } from "@/lib/types";
import { NO_STORE, errorResponse, handleError } from "../../team/lineup/shared";

export const dynamic = "force-dynamic";

async function userId(): Promise<number | null> {
  const session = await getSession((await cookies()).get(SESSION_COOKIE)?.value);
  return session?.user.id ?? null;
}

export async function GET() {
  try {
    const id = await userId();
    if (id === null) return errorResponse("Sign in to see league settings.", 401);
    const found = await getLeagueSettings(pool, CURRENT_SEASON, id);
    if (!found) return errorResponse("No league for this season.", 404);
    if (!found.isCommissioner) return errorResponse("Only the commissioner can change league settings.", 403);
    return NextResponse.json(found.data, { headers: NO_STORE });
  } catch (err) {
    return handleError("GET /api/league/settings", err);
  }
}

export async function PUT(req: Request) {
  try {
    const id = await userId();
    if (id === null) return errorResponse("Sign in to change league settings.", 401);
    const body = await req.json().catch(() => null);
    return NextResponse.json(await updateLeagueSettings(pool, CURRENT_SEASON, id, body), { headers: NO_STORE });
  } catch (err) {
    return handleError("PUT /api/league/settings", err);
  }
}

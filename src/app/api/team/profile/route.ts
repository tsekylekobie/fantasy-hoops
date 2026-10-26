// PATCH /api/team/profile  rename your team or change its abbreviation (the commissioner: any team, via teamId)
// Contract: TeamProfileUpdate -> FantasyTeamSummary in src/lib/types.ts.
// 401 signed out, 403 not your team, 404 no such team, 400 bad input, 409 name or abbreviation taken.
// Logic: src/lib/queries/teamProfile.ts.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { updateTeamProfile } from "@/lib/queries/teamProfile";
import { CURRENT_SEASON } from "@/lib/types";
import { NO_STORE, errorResponse, handleError, sessionUserId } from "../lineup/shared";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request) {
  try {
    const id = await sessionUserId();
    if (id === null) return errorResponse("Sign in to edit your team.", 401);
    const body = await req.json().catch(() => null);
    return NextResponse.json(await updateTeamProfile(pool, id, CURRENT_SEASON, body), { headers: NO_STORE });
  } catch (err) {
    return handleError("PATCH /api/team/profile", err);
  }
}

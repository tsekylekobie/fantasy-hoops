// PUT    /api/team/profile/logo?team=<id>  body: the image (PNG, JPEG or WebP, up to 1 MB); replaces the logo
// DELETE /api/team/profile/logo?team=<id>  removes it
// team defaults to your own; the commissioner may name any team. Both respond with the FantasyTeamSummary.
// 401 signed out, 403 not your team, 404 no such team, 400 bad team / empty, 413 too big, 415 not an image.
// Logic: src/lib/queries/teamProfile.ts.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { removeTeamLogo, setTeamLogo } from "@/lib/queries/teamProfile";
import { CURRENT_SEASON, TEAM_LOGO_MAX_BYTES } from "@/lib/types";
import { NO_STORE, errorResponse, handleError, sessionUserId } from "../../lineup/shared";

export const dynamic = "force-dynamic";

/** The ?team= id; undefined for your own team, null if it's malformed. */
function teamParam(req: Request): number | undefined | null {
  const raw = new URL(req.url).searchParams.get("team");
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function PUT(req: Request) {
  try {
    const id = await sessionUserId();
    if (id === null) return errorResponse("Sign in to edit your team.", 401);
    const team = teamParam(req);
    if (team === null) return errorResponse("team must be a team id.", 400);
    if (Number(req.headers.get("content-length") ?? 0) > TEAM_LOGO_MAX_BYTES) return errorResponse("The logo must be 1 MB or smaller.", 413);
    const bytes = new Uint8Array(await req.arrayBuffer());
    return NextResponse.json(await setTeamLogo(pool, id, CURRENT_SEASON, team, bytes), { headers: NO_STORE });
  } catch (err) {
    return handleError("PUT /api/team/profile/logo", err);
  }
}

export async function DELETE(req: Request) {
  try {
    const id = await sessionUserId();
    if (id === null) return errorResponse("Sign in to edit your team.", 401);
    const team = teamParam(req);
    if (team === null) return errorResponse("team must be a team id.", 400);
    return NextResponse.json(await removeTeamLogo(pool, id, CURRENT_SEASON, team), { headers: NO_STORE });
  } catch (err) {
    return handleError("DELETE /api/team/profile/logo", err);
  }
}

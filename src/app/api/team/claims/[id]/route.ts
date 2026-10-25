// DELETE /api/team/claims/:id  cancel one of the signed-in manager's pending claims.
// Responds with MyClaimsResponse (src/lib/types.ts).
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { cancelClaim, getMyClaims } from "@/lib/queries/waivers";
import { NO_STORE, errorResponse, handleError, requireTeam } from "../../lineup/shared";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const team = await requireTeam();
    if (team instanceof NextResponse) return team;
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) return errorResponse("Bad claim id", 400);
    await cancelClaim(pool, team, id);
    return NextResponse.json(await getMyClaims(pool, team), { headers: NO_STORE });
  } catch (err) {
    return handleError("DELETE /api/team/claims/:id", err);
  }
}

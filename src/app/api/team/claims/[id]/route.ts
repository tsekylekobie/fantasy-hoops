// PATCH  /api/team/claims/:id { bid }  change a pending claim's FAAB bid.
// DELETE /api/team/claims/:id          cancel one of the signed-in manager's pending claims.
// Both respond with MyClaimsResponse (src/lib/types.ts).
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { cancelClaim, getMyClaims, setClaimBid } from "@/lib/queries/waivers";
import { NO_STORE, errorResponse, handleError, requireTeam } from "../../lineup/shared";

export const dynamic = "force-dynamic";

const claimId = async (params: Promise<{ id: string }>) => {
  const id = Number((await params).id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const team = await requireTeam();
    if (team instanceof NextResponse) return team;
    const id = await claimId(params);
    if (id === null) return errorResponse("Bad claim id", 400);
    const body = (await req.json().catch(() => null)) as { bid?: unknown } | null;
    await setClaimBid(pool, team, id, body?.bid);
    return NextResponse.json(await getMyClaims(pool, team), { headers: NO_STORE });
  } catch (err) {
    return handleError("PATCH /api/team/claims/:id", err);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const team = await requireTeam();
    if (team instanceof NextResponse) return team;
    const id = await claimId(params);
    if (id === null) return errorResponse("Bad claim id", 400);
    await cancelClaim(pool, team, id);
    return NextResponse.json(await getMyClaims(pool, team), { headers: NO_STORE });
  } catch (err) {
    return handleError("DELETE /api/team/claims/:id", err);
  }
}

// GET /api/team/claims          the signed-in manager's pending and recent waiver claims
// PUT /api/team/claims { order } reorder the pending claims (first = tried first)
// Contract: MyClaimsResponse and ClaimOrderRequest in src/lib/types.ts. Claims are
// placed through POST /api/team/transactions; the run is src/lib/queries/waivers.ts.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { getMyClaims, reorderClaims } from "@/lib/queries/waivers";
import { NO_STORE, errorResponse, handleError, requireTeam } from "../lineup/shared";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const team = await requireTeam();
    if (team instanceof NextResponse) return team;
    return NextResponse.json(await getMyClaims(pool, team), { headers: NO_STORE });
  } catch (err) {
    return handleError("GET /api/team/claims", err);
  }
}

export async function PUT(req: Request) {
  try {
    const team = await requireTeam();
    if (team instanceof NextResponse) return team;
    const body = (await req.json().catch(() => null)) as { order?: unknown } | null;
    const order = body?.order;
    if (!Array.isArray(order) || !order.every((id) => Number.isInteger(id) && id > 0)) {
      return errorResponse("order must be a list of claim ids", 400);
    }
    await reorderClaims(pool, team, order as number[]);
    return NextResponse.json(await getMyClaims(pool, team), { headers: NO_STORE });
  } catch (err) {
    return handleError("PUT /api/team/claims", err);
  }
}

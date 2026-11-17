// GET /api/yahoo/status  the Yahoo mirror's state: connected?, last refresh, last error (YahooStatusResponse).
// Signed-in league members only (401 signed out, 403 not in the league).
import { NextResponse } from "next/server";
import { NO_STORE, errorResponse, handleError, viewer, yahooStatus } from "../shared";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const v = await viewer();
    if (!v) return errorResponse("Sign in to see the Yahoo connection.", 401);
    if (!v.member) return errorResponse("You're not in this league.", 403);
    return NextResponse.json(await yahooStatus(v.admin), { headers: NO_STORE });
  } catch (err) {
    return handleError("GET /api/yahoo/status", err);
  }
}

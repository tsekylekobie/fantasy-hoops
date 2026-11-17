// POST /api/yahoo/refresh  syncs from Yahoo now: today's rosters, the latest transactions and this
// week's scoreboard (src/lib/yahoo/sync.ts; a full pass if one is due). Any signed-in league member;
// at most once a minute for the whole league (429 with Retry-After otherwise). Answers
// YahooRefreshResponse; 409 when Yahoo isn't connected.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import type { YahooRefreshResponse } from "@/lib/types";
import { claimManualRefresh, getConnection } from "@/lib/yahoo/connection";
import { syncYahoo } from "@/lib/yahoo/sync";
import { NO_STORE, errorResponse, handleError, viewer, yahooStatus } from "../shared";

export const dynamic = "force-dynamic";
// A full pass can take a while.
export const maxDuration = 120;

export async function POST() {
  try {
    const v = await viewer();
    if (!v) return errorResponse("Sign in to refresh from Yahoo.", 401);
    if (!v.member) return errorResponse("You're not in this league.", 403);
    if (!(await getConnection(pool))) return errorResponse("Yahoo isn't connected yet.", 409);
    const claim = await claimManualRefresh(pool);
    if (!claim.ok) {
      return errorResponse(`Refreshed less than a minute ago; try again in ${claim.retryInSeconds} s.`, 429, { "Retry-After": String(claim.retryInSeconds) });
    }
    const r = await syncYahoo(pool, { manual: true });
    const body: YahooRefreshResponse = {
      ok: r.status === "ok",
      message: r.status === "ok" ? null : r.summary,
      status: await yahooStatus(v.admin),
    };
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (err) {
    return handleError("POST /api/yahoo/refresh", err);
  }
}

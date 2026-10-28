// GET /api/trades/analysis?teams=A,B: rosters, per-game lines and values (with the
// signed-in manager's punt weights) and league totals for the trade analyzer.
// Contract: TradeAnalysisResponse in src/lib/types.ts. Rules: src/lib/trades/analysis.ts.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { getTradeAnalysis } from "@/lib/queries/tradeAnalysis";
import { NO_STORE, context, errorResponse, handleError } from "../shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const ids = (new URL(req.url).searchParams.get("teams") ?? "").split(",").map(Number);
    if (ids.length !== 2 || !ids.every((n) => Number.isInteger(n) && n > 0)) {
      return errorResponse("teams must be two team ids, e.g. teams=3,7", 400);
    }
    const ctx = await context(true);
    if (ctx instanceof NextResponse) return ctx;
    return NextResponse.json(await getTradeAnalysis(pool, ctx.league, ctx.userId!, [ids[0], ids[1]]), { headers: NO_STORE });
  } catch (err) {
    return handleError("GET /api/trades/analysis", err);
  }
}

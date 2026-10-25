// GET /api/trades/builder?team=ID: the signed-in manager's roster and team ID's,
// for the trade builder. Contract: TradeBuilderResponse in src/lib/types.ts.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { getTradeBuilder } from "@/lib/queries/trades";
import { NO_STORE, context, errorResponse, handleError } from "../shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const team = Number(new URL(req.url).searchParams.get("team"));
    if (!Number.isInteger(team) || team <= 0) return errorResponse("team must be a team id", 400);
    const ctx = await context(true);
    if (ctx instanceof NextResponse) return ctx;
    return NextResponse.json(await getTradeBuilder(pool, ctx.league, ctx.userId!, team), { headers: NO_STORE });
  } catch (err) {
    return handleError("GET /api/trades/builder", err);
  }
}

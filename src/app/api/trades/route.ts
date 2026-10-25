// GET  /api/trades  open trades and recent ones (TradesResponse); processes due trades first.
// POST /api/trades  propose (TradeProposal), responds with the Trade.
// Contract: src/lib/types.ts. Rules: src/lib/queries/trades.ts.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { listTrades, proposeTrade } from "@/lib/queries/trades";
import type { TradeProposal } from "@/lib/types";
import { NO_STORE, context, errorResponse, handleError } from "./shared";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ctx = await context(false);
    if (ctx instanceof NextResponse) return ctx;
    return NextResponse.json(await listTrades(pool, ctx.league, ctx.userId), { headers: NO_STORE });
  } catch (err) {
    return handleError("GET /api/trades", err);
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await context(true);
    if (ctx instanceof NextResponse) return ctx;
    const body = (await req.json().catch(() => null)) as Partial<TradeProposal> | null;
    if (!body || typeof body !== "object") return errorResponse("Expected a JSON trade proposal.", 400);
    const trade = await proposeTrade(pool, ctx.league, ctx.userId!, body);
    return NextResponse.json(trade, { status: 201, headers: NO_STORE });
  } catch (err) {
    return handleError("POST /api/trades", err);
  }
}

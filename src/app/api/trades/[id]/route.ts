// POST /api/trades/:id { action: TradeAction }: accept, reject, cancel, vote,
// unvote or veto. Responds with the Trade as it now stands.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { actOnTrade } from "@/lib/queries/trades";
import type { TradeAction } from "@/lib/types";
import { NO_STORE, context, errorResponse, handleError } from "../shared";

export const dynamic = "force-dynamic";

const ACTIONS: readonly TradeAction[] = ["accept", "reject", "cancel", "vote", "unvote", "veto"];

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) return errorResponse("No such trade.", 404);
    const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
    const action = body?.action as TradeAction;
    if (!ACTIONS.includes(action)) return errorResponse(`action must be one of ${ACTIONS.join(", ")}`, 400);
    const ctx = await context(true);
    if (ctx instanceof NextResponse) return ctx;
    return NextResponse.json(await actOnTrade(pool, ctx.league, ctx.userId!, id, action), { headers: NO_STORE });
  } catch (err) {
    return handleError("POST /api/trades/:id", err);
  }
}

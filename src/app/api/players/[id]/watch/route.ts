// PUT    /api/players/:id/watch   add him to your watchlist
// DELETE /api/players/:id/watch   take him off it
// Both are no-ops when already so; 401 signed out, 404 no such player.
// Contract: WatchResponse in src/lib/types.ts. Logic: src/lib/queries/watchlist.ts.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { BadRequest, parsePlayerId } from "@/lib/queries/params";
import { setWatched } from "@/lib/queries/watchlist";
import type { WatchResponse } from "@/lib/types";
import { NO_STORE, errorResponse, handleError, sessionUserId } from "../../../team/lineup/shared";

export const dynamic = "force-dynamic";

async function toggle(params: Promise<{ id: string }>, watched: boolean): Promise<NextResponse> {
  const route = `${watched ? "PUT" : "DELETE"} /api/players/:id/watch`;
  try {
    const playerId = parsePlayerId((await params).id);
    const userId = await sessionUserId();
    if (userId === null) return errorResponse("Sign in to use your watchlist.", 401);
    if (!(await setWatched(pool, userId, playerId, watched))) return errorResponse("Player not found.", 404);
    const body: WatchResponse = { playerId, watched };
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof BadRequest) return errorResponse(err.message, 400);
    return handleError(route, err);
  }
}

export async function PUT(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return toggle(params, true);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return toggle(params, false);
}

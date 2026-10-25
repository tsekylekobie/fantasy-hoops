// Shared by the trade routes: who's asking, the league, and error responses.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/config";
import { getSession } from "@/lib/auth/session";
import { pool } from "@/lib/db";
import { TradeError, getTradeLeague, type TradeLeague } from "@/lib/queries/trades";
import { CURRENT_SEASON } from "@/lib/types";

export const NO_STORE = { "Cache-Control": "private, no-store" };

export function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: NO_STORE });
}

/** The season's league and the signed-in user's id (null when signed out and `signedIn` isn't required). */
export async function context(
  signedIn: boolean,
): Promise<{ league: TradeLeague; userId: number | null } | NextResponse> {
  const session = await getSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (signedIn && !session) return errorResponse("Sign in to make trades.", 401);
  const league = await getTradeLeague(pool, CURRENT_SEASON);
  if (!league) return errorResponse("No league for this season yet.", 404);
  return { league, userId: session?.user.id ?? null };
}

export function handleError(route: string, err: unknown): NextResponse {
  if (err instanceof TradeError) return errorResponse(err.message, err.status);
  console.error(`${route} failed`, err);
  return errorResponse("Internal error", 500);
}

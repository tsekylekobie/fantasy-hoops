// Shared by the /api/yahoo routes: who's asking, and the status they see.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/config";
import { getSession } from "@/lib/auth/session";
import { pool } from "@/lib/db";
import type { YahooStatusResponse } from "@/lib/types";
import { statusFor, yahooRole } from "@/lib/yahoo/connection";

export const NO_STORE = { "Cache-Control": "private, no-store" };

export function errorResponse(message: string, status: number, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: { ...NO_STORE, ...headers } });
}

export interface Viewer {
  userId: number;
  member: boolean;
  admin: boolean;
}

/** The signed-in viewer and their role, or null when signed out. */
export async function viewer(): Promise<Viewer | null> {
  const session = await getSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) return null;
  return { userId: session.user.id, ...(await yahooRole(pool, session.user.id)) };
}

/** The status the viewer sees (statusFor in connection.ts). */
export function yahooStatus(canManage: boolean): Promise<YahooStatusResponse> {
  return statusFor(pool, canManage);
}

export function handleError(route: string, err: unknown): NextResponse {
  console.error(route, err);
  return errorResponse("Something went wrong. Please try again.", 500);
}

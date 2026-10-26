// Shared by the lineup routes: who's asking, and which date.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/config";
import { getSession } from "@/lib/auth/session";
import { pool } from "@/lib/db";
import { LineupError, getUserTeam, type TeamContext } from "@/lib/queries/lineup";
import { CURRENT_SEASON } from "@/lib/types";

export const NO_STORE = { "Cache-Control": "private, no-store" };

export function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: NO_STORE });
}

/** The signed-in user's id; null when signed out. */
export async function sessionUserId(): Promise<number | null> {
  const session = await getSession((await cookies()).get(SESSION_COOKIE)?.value);
  return session?.user.id ?? null;
}

/** The signed-in user's team, or an error response to return instead. */
export async function requireTeam(): Promise<TeamContext | NextResponse> {
  const session = await getSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) return errorResponse("Sign in to manage your team.", 401);
  const team = await getUserTeam(pool, session.user.id, CURRENT_SEASON);
  if (!team) return errorResponse("You don't have a team in this league.", 404);
  return team;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A yyyy-mm-dd string that is a real calendar date, else null. */
export function parseDate(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}

export function handleError(route: string, err: unknown): NextResponse {
  if (err instanceof LineupError) return errorResponse(err.message, err.status);
  console.error(`${route} failed`, err);
  return errorResponse("Internal error", 500);
}

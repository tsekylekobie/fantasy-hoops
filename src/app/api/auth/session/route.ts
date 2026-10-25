// GET /api/auth/session — who is signed in on this device.
// Contract: SessionResponse in src/lib/types.ts. Also slides the session's
// expiry forward (at most once a day), which is what keeps a device signed in.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, mockAuthEnabled } from "@/lib/auth/config";
import { clearSessionCookie, getSession, refreshSession } from "@/lib/auth/session";
import type { SessionResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await getSession(token);
  const body: SessionResponse = { user: session?.user ?? null, mock: mockAuthEnabled() };
  const res = NextResponse.json(body, { headers: { "Cache-Control": "private, no-store" } });
  if (token && !session) clearSessionCookie(res);
  else if (token && session?.stale) await refreshSession(res, token);
  return res;
}

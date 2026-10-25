// POST /api/auth/sign-out — ends this device's session only.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/config";
import { clearSessionCookie, endSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function POST() {
  await endSession((await cookies()).get(SESSION_COOKIE)?.value);
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}

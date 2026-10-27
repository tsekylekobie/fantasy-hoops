// GET /api/auth/google/callback — Google redirects here after the user picks
// an account. Checks state, exchanges the code, and signs this device in.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { OAUTH_COOKIE, appOrigin } from "@/lib/auth/config";
import { exchangeCode, type OAuthState } from "@/lib/auth/google";
import { linkMemberships } from "@/lib/auth/members";
import { startSession, upsertUser } from "@/lib/auth/session";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  let saved: OAuthState | null = null;
  try {
    saved = JSON.parse((await cookies()).get(OAUTH_COOKIE)?.value ?? "null");
  } catch {
    // Malformed cookie: treated as missing below.
  }
  if (!saved || !saved.state || saved.state !== params.get("state")) {
    return new NextResponse("Sign-in expired or was started in another browser. Please try again.", { status: 400 });
  }

  const done = (path: string) => {
    const res = NextResponse.redirect(new URL(path, appOrigin(req)));
    res.cookies.set(OAUTH_COOKIE, "", { path: "/api/auth/google", maxAge: 0 });
    return res;
  };

  // The user cancelled on Google's screen: just go back where they were.
  const code = params.get("code");
  if (params.get("error") || !code) return done(saved.next);

  try {
    const profile = await exchangeCode(code, saved.verifier, `${appOrigin(req)}/api/auth/google/callback`);
    const userId = await upsertUser(profile);
    await linkMemberships(pool, userId, profile.email);
    const res = done(saved.next);
    await startSession(res, userId, req.headers.get("user-agent"));
    return res;
  } catch (err) {
    console.error("Google sign-in failed", err);
    return new NextResponse("Google sign-in failed. Please try again.", { status: 502 });
  }
}

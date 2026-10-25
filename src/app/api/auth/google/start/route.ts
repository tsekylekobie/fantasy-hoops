// GET /api/auth/google/start?next=/path — sends the browser to Google (or to
// the mock sign-in page in local dev).
import { NextResponse } from "next/server";
import { OAUTH_COOKIE, appOrigin, mockAuthEnabled, safeNext, secureCookies } from "@/lib/auth/config";
import { authorizationUrl, newOAuthState } from "@/lib/auth/google";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const next = safeNext(new URL(req.url).searchParams.get("next"));
  if (mockAuthEnabled()) {
    return NextResponse.redirect(new URL(`/dev/sign-in?next=${encodeURIComponent(next)}`, req.url));
  }

  const s = newOAuthState(next);
  const res = NextResponse.redirect(authorizationUrl(s, `${appOrigin(req)}/api/auth/google/callback`));
  res.cookies.set(OAUTH_COOKIE, JSON.stringify(s), {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax", // sent on Google's top-level redirect back to us
    path: "/api/auth/google",
    maxAge: 10 * 60,
  });
  return res;
}

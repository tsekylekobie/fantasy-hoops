// GET /api/auth/<google|yahoo>/callback — the provider redirects here after the
// user signs in. Checks state, exchanges the code, and signs this device in.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { OAUTH_COOKIE, appOrigin } from "@/lib/auth/config";
import { linkMemberships } from "@/lib/auth/members";
import { configuredProviders, exchangeCode, isOAuthProvider, providerLabel, type OAuthState } from "@/lib/auth/oidc";
import { signInUser, startSession } from "@/lib/auth/session";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params: routeParams }: { params: Promise<{ provider: string }> }) {
  const { provider } = await routeParams;
  if (!isOAuthProvider(provider) || !configuredProviders().includes(provider)) {
    return new NextResponse("Not found", { status: 404 });
  }
  const label = providerLabel(provider);
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
    res.cookies.set(OAUTH_COOKIE, "", { path: `/api/auth/${provider}`, maxAge: 0 });
    return res;
  };

  // The user cancelled on the provider's screen: just go back where they were.
  const code = params.get("code");
  if (params.get("error") || !code) return done(saved.next);

  try {
    const profile = await exchangeCode(provider, code, saved.verifier, `${appOrigin(req)}/api/auth/${provider}/callback`);
    const userId = await signInUser(profile);
    if (profile.emailVerified) {
      await linkMemberships(pool, userId, profile.email);
    } else {
      console.warn(`${label} sign-in: ${profile.email} is not verified by ${label}; not linking league teams`);
    }
    const res = done(saved.next);
    await startSession(res, userId, req.headers.get("user-agent"));
    return res;
  } catch (err) {
    console.error(`${label} sign-in failed`, err);
    return new NextResponse(`${label} sign-in failed. Please try again.`, { status: 502 });
  }
}

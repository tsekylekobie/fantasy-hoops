// GET /api/auth/<google|yahoo>/start?next=/path — sends the browser to the
// provider's sign-in (or to the mock sign-in page in local dev).
import { NextResponse } from "next/server";
import { OAUTH_COOKIE, appOrigin, mockAuthEnabled, safeNext, secureCookies } from "@/lib/auth/config";
import { authorizationUrl, configuredProviders, isOAuthProvider, newOAuthState } from "@/lib/auth/oidc";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const next = safeNext(new URL(req.url).searchParams.get("next"));
  if (mockAuthEnabled()) {
    return NextResponse.redirect(new URL(`/dev/sign-in?next=${encodeURIComponent(next)}`, req.url));
  }
  if (!isOAuthProvider(provider) || !configuredProviders().includes(provider)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const s = newOAuthState(next);
  const res = NextResponse.redirect(authorizationUrl(provider, s, `${appOrigin(req)}/api/auth/${provider}/callback`));
  res.cookies.set(OAUTH_COOKIE, JSON.stringify(s), {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax", // sent on the provider's top-level redirect back to us
    path: `/api/auth/${provider}`,
    maxAge: 10 * 60,
  });
  return res;
}

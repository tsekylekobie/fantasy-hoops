// GET /api/yahoo/connect  sends the commissioner to Yahoo to connect the league (OAuth 2.0
// authorization code flow, Fantasy Sports read). Yahoo comes back to /api/yahoo/callback.
// A connection, not a sign-in: sign-in stays Google. Signed out -> /league; not the
// commissioner -> 403; Yahoo keys not set -> 404.
import { NextResponse } from "next/server";
import { appOrigin, secureCookies } from "@/lib/auth/config";
import { YAHOO_OAUTH_COOKIE, newYahooState, yahooAuthorizationUrl, yahooConfigured } from "@/lib/yahoo/oauth";
import { errorResponse, handleError, viewer } from "../shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    if (!yahooConfigured()) return errorResponse("Yahoo isn't set up on this server (YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET, YAHOO_TOKEN_KEY).", 404);
    const v = await viewer();
    if (!v) return NextResponse.redirect(new URL("/league", appOrigin(req)));
    if (!v.admin) return errorResponse("Only the commissioner can connect Yahoo.", 403);
    const s = newYahooState(v.userId);
    const res = NextResponse.redirect(yahooAuthorizationUrl(s.state, `${appOrigin(req)}/api/yahoo/callback`));
    res.cookies.set(YAHOO_OAUTH_COOKIE, JSON.stringify(s), {
      httpOnly: true,
      secure: secureCookies(),
      sameSite: "lax", // sent on Yahoo's top-level redirect back to us
      path: "/api/yahoo",
      maxAge: 10 * 60,
    });
    return res;
  } catch (err) {
    return handleError("GET /api/yahoo/connect", err);
  }
}

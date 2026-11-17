// GET /api/yahoo/callback  Yahoo redirects here after the commissioner allows access. Checks the
// state (and that the same user is signed in), exchanges the code, stores the tokens encrypted,
// and picks the league when the account has exactly one this season. Then back to /league/yahoo,
// where the first sync can be started (else the worker's next pass does it).
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { appOrigin } from "@/lib/auth/config";
import { pool } from "@/lib/db";
import { saveConnection, setLeagueKey } from "@/lib/yahoo/connection";
import { YAHOO_OAUTH_COOKIE, checkCallback, exchangeYahooCode, yahooConfigured, type YahooOAuthState } from "@/lib/yahoo/oauth";
import { fetchUserLeagues } from "@/lib/yahoo/sync";
import { viewer } from "../shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!yahooConfigured()) return new NextResponse("Not found", { status: 404 });
  const params = new URL(req.url).searchParams;
  let saved: YahooOAuthState | null = null;
  try {
    saved = JSON.parse((await cookies()).get(YAHOO_OAUTH_COOKIE)?.value ?? "null");
  } catch {
    // Malformed cookie: treated as missing.
  }
  const v = await viewer();
  const checked = checkCallback(saved, params, v?.admin ? v.userId : null);
  if ("error" in checked) return new NextResponse(checked.error, { status: 400 });

  const done = (query: string) => {
    const res = NextResponse.redirect(new URL(`/league/yahoo${query}`, appOrigin(req)));
    res.cookies.set(YAHOO_OAUTH_COOKIE, "", { path: "/api/yahoo", maxAge: 0 });
    return res;
  };
  // Cancelled on Yahoo's screen: back to the page, nothing changed.
  if ("cancelled" in checked) return done("");

  const redirectUri = `${appOrigin(req)}/api/yahoo/callback`;
  try {
    const tokens = await exchangeYahooCode(checked.code, redirectUri);
    await saveConnection(pool, tokens, v!.userId, redirectUri);
  } catch (err) {
    console.error("Yahoo connect failed", err);
    return new NextResponse("Connecting Yahoo failed. Please try again.", { status: 502 });
  }
  try {
    const leagues = await fetchUserLeagues(pool);
    if (leagues.length === 1) await setLeagueKey(pool, leagues[0].key);
  } catch (err) {
    // The page lists the leagues again (and the worker retries), so this isn't fatal.
    console.error("Yahoo connect: listing leagues failed", err);
  }
  return done("?connected=1");
}

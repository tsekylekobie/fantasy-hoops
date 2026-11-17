// The Yahoo connection's OAuth 2.0 (authorization code flow): a data
// connection for the league mirror, not a sign-in (sign-in stays Google). The
// commissioner connects once at /league/yahoo (/api/yahoo/connect, then
// /api/yahoo/callback); the refresh token is stored encrypted (connection.ts)
// and access tokens (an hour each) are refreshed from it as needed.
// Register <APP_URL>/api/yahoo/callback as the app's redirect URI, with the
// Fantasy Sports read permission.
import { randomBytes } from "node:crypto";

export const YAHOO_AUTH_URL = "https://api.login.yahoo.com/oauth2/request_auth";
export const YAHOO_TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
/** Fantasy Sports, read. */
export const YAHOO_SCOPE = "fspt-r";
export const YAHOO_OAUTH_COOKIE = "fh_yahoo_oauth";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export function yahooConfigured(): boolean {
  return !!(process.env.YAHOO_CLIENT_ID && process.env.YAHOO_CLIENT_SECRET && process.env.YAHOO_TOKEN_KEY);
}

function credentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.YAHOO_CLIENT_ID;
  const clientSecret = process.env.YAHOO_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET must be set");
  return { clientId, clientSecret };
}

/** The state we keep in a short-lived cookie between the redirect and the callback. */
export interface YahooOAuthState {
  state: string;
  /** Who started it: the callback only accepts the same signed-in user. */
  userId: number;
}

export function newYahooState(userId: number): YahooOAuthState {
  return { state: randomBytes(16).toString("base64url"), userId };
}

/** Pure but for the env: where to send the browser. */
export function yahooAuthorizationUrl(state: string, redirectUri: string, clientId = credentials().clientId): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: YAHOO_SCOPE,
    state,
    language: "en-us",
  });
  return `${YAHOO_AUTH_URL}?${params}`;
}

/** Checks the callback against the saved state (pure): the code to exchange, or why not. */
export function checkCallback(
  saved: YahooOAuthState | null, params: URLSearchParams, userId: number | null,
): { code: string } | { cancelled: true } | { error: string } {
  if (!saved || !saved.state || saved.state !== params.get("state")) return { error: "The Yahoo connection expired or was started in another browser. Please try again." };
  if (userId === null || saved.userId !== userId) return { error: "Sign in as the manager who started the Yahoo connection, then try again." };
  const code = params.get("code");
  if (params.get("error") || !code) return { cancelled: true };
  return { code };
}

export interface YahooTokens {
  accessToken: string;
  /** Yahoo may send a new one on refresh; else the old one stays good. */
  refreshToken: string | null;
  expiresAt: Date;
  guid: string | null;
}

/** Turns the token endpoint's JSON into tokens (pure). Expires a minute early, to be safe. */
export function parseTokenResponse(body: unknown, nowMs: number): YahooTokens {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.access_token !== "string" || !b.access_token) {
    const why = typeof b.error_description === "string" ? b.error_description : typeof b.error === "string" ? b.error : "no access_token";
    throw new Error(`Yahoo token response: ${why}`);
  }
  const expiresIn = Number(b.expires_in);
  return {
    accessToken: b.access_token,
    refreshToken: typeof b.refresh_token === "string" && b.refresh_token ? b.refresh_token : null,
    expiresAt: new Date(nowMs + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000 - 60_000),
    guid: typeof b.xoauth_yahoo_guid === "string" ? b.xoauth_yahoo_guid : null,
  };
}

async function tokenRequest(params: Record<string, string>, fetchFn: FetchFn): Promise<YahooTokens> {
  const { clientId, clientSecret } = credentials();
  const res = await fetchFn(YAHOO_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: reported below.
  }
  if (!res.ok) {
    const b = (body ?? {}) as Record<string, unknown>;
    const why = typeof b.error_description === "string" ? b.error_description : typeof b.error === "string" ? b.error : text.slice(0, 200);
    throw new Error(`Yahoo token request failed (${res.status}): ${why}`);
  }
  return parseTokenResponse(body, Date.now());
}

export function exchangeYahooCode(code: string, redirectUri: string, fetchFn: FetchFn = fetch): Promise<YahooTokens> {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri }, fetchFn);
}

export function refreshYahooTokens(refreshToken: string, redirectUri: string, fetchFn: FetchFn = fetch): Promise<YahooTokens> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, redirect_uri: redirectUri }, fetchFn);
}

// Google sign-in: the OAuth 2.0 authorization-code flow with PKCE, using
// OpenID Connect for the profile. No SDK; it is two HTTP calls.
import { createHash, randomBytes } from "node:crypto";
import type { Profile } from "./session";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function googleCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
  return { clientId, clientSecret };
}

/** What we keep in a short-lived cookie between the redirect and the callback. */
export interface OAuthState {
  state: string;
  verifier: string;
  next: string;
}

export function newOAuthState(next: string): OAuthState {
  return { state: randomBytes(16).toString("base64url"), verifier: randomBytes(32).toString("base64url"), next };
}

export function authorizationUrl(s: OAuthState, redirectUri: string): string {
  const { clientId } = googleCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: s.state,
    code_challenge: createHash("sha256").update(s.verifier).digest("base64url"),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `${AUTH_URL}?${params}`;
}

interface IdTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

/**
 * Exchanges the callback's code for the user's profile. The ID token comes
 * straight from Google's token endpoint over TLS, so per OpenID Connect Core
 * §3.1.3.7 we check its claims without verifying the signature.
 */
export async function exchangeCode(code: string, verifier: string, redirectUri: string): Promise<Profile> {
  const { clientId, clientSecret } = googleCredentials();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  const { id_token } = (await res.json()) as { id_token?: string };
  if (!id_token) throw new Error("Google token response had no id_token");

  const claims = JSON.parse(Buffer.from(id_token.split(".")[1] ?? "", "base64url").toString("utf8")) as IdTokenClaims;
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
    throw new Error(`Unexpected ID token issuer: ${claims.iss}`);
  }
  if (claims.aud !== clientId) throw new Error("ID token audience mismatch");
  if (claims.exp * 1000 < Date.now()) throw new Error("ID token expired");
  if (!claims.email || !claims.email_verified) throw new Error("Google account has no verified email");

  return {
    googleSub: claims.sub,
    email: claims.email,
    name: claims.name || claims.email,
    pictureUrl: claims.picture ?? null,
  };
}

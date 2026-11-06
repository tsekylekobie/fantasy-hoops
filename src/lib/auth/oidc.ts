// Sign-in with Google: the OAuth 2.0 authorization-code flow with PKCE, using
// OpenID Connect for the profile. No SDK; it is two HTTP calls. Providers are
// rows in PROVIDERS; the routes are /api/auth/<provider>/start and
// /api/auth/<provider>/callback (register the callback with the provider).
import { createHash, randomBytes } from "node:crypto";
import type { Profile } from "./session";

export type OAuthProvider = "google";

interface ProviderConfig {
  label: string;
  authUrl: string;
  tokenUrl: string;
  issuers: string[];
  idEnv: string;
  secretEnv: string;
  /** Extra authorization parameters. */
  extra: Record<string, string>;
}

const PROVIDERS: Record<OAuthProvider, ProviderConfig> = {
  google: {
    label: "Google",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    idEnv: "GOOGLE_CLIENT_ID",
    secretEnv: "GOOGLE_CLIENT_SECRET",
    extra: { prompt: "select_account" },
  },
};

export function isOAuthProvider(p: string): p is OAuthProvider {
  return Object.hasOwn(PROVIDERS, p);
}

export function providerLabel(p: OAuthProvider): string {
  return PROVIDERS[p].label;
}

/** Providers whose client id and secret are set. */
export function configuredProviders(): OAuthProvider[] {
  return (Object.keys(PROVIDERS) as OAuthProvider[]).filter(
    (p) => process.env[PROVIDERS[p].idEnv] && process.env[PROVIDERS[p].secretEnv],
  );
}

function credentials(p: OAuthProvider): { clientId: string; clientSecret: string } {
  const { idEnv, secretEnv } = PROVIDERS[p];
  const clientId = process.env[idEnv];
  const clientSecret = process.env[secretEnv];
  if (!clientId || !clientSecret) throw new Error(`${idEnv} and ${secretEnv} must be set`);
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

export function authorizationUrl(p: OAuthProvider, s: OAuthState, redirectUri: string): string {
  const { clientId } = credentials(p);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: s.state,
    code_challenge: createHash("sha256").update(s.verifier).digest("base64url"),
    code_challenge_method: "S256",
    ...PROVIDERS[p].extra,
  });
  return `${PROVIDERS[p].authUrl}?${params}`;
}

export interface IdTokenClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  exp: number;
  email?: string;
  /** Google sends a boolean; some providers send "true". */
  email_verified?: boolean | string;
  name?: string;
  given_name?: string;
  family_name?: string;
  nickname?: string;
  picture?: string;
}

/** Checks an ID token's claims (pure) and turns them into a profile. */
export function profileFromClaims(p: OAuthProvider, claims: IdTokenClaims, clientId: string, nowMs: number): Profile {
  const { label, issuers } = PROVIDERS[p];
  if (!issuers.includes(claims.iss)) throw new Error(`Unexpected ${label} ID token issuer: ${claims.iss}`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new Error(`${label} ID token audience mismatch`);
  if (!(claims.exp * 1000 > nowMs)) throw new Error(`${label} ID token expired`);
  if (!claims.sub) throw new Error(`${label} ID token has no subject`);
  const email = claims.email?.trim();
  if (!email) throw new Error(`${label} account shared no email`);

  const fullName = [claims.given_name, claims.family_name].filter(Boolean).join(" ");
  return {
    provider: p,
    subject: claims.sub,
    email,
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    name: claims.name?.trim() || fullName || claims.nickname?.trim() || email,
    pictureUrl: claims.picture || null,
  };
}

/**
 * Exchanges the callback's code for the user's profile. The ID token comes
 * straight from the provider's token endpoint over TLS, so per OpenID Connect
 * Core §3.1.3.7 we check its claims without verifying the signature.
 */
export async function exchangeCode(p: OAuthProvider, code: string, verifier: string, redirectUri: string): Promise<Profile> {
  const { clientId, clientSecret } = credentials(p);
  const { tokenUrl, label } = PROVIDERS[p];
  const res = await fetch(tokenUrl, {
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
  if (!res.ok) throw new Error(`${label} token exchange failed: ${res.status} ${await res.text()}`);
  const { id_token } = (await res.json()) as { id_token?: string };
  if (!id_token) throw new Error(`${label} token response had no id_token `);

  const claims = JSON.parse(Buffer.from(id_token.split(".")[1] ?? "", "base64url").toString("utf8")) as IdTokenClaims;
  return profileFromClaims(p, claims, clientId, Date.now());
}

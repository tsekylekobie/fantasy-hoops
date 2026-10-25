// Auth settings shared by the routes. Secrets come from .env (see .env.example).

export const SESSION_COOKIE = "fh_session";
export const OAUTH_COOKIE = "fh_oauth";

/**
 * How long a device stays signed in without being used. Every visit pushes
 * the expiry out again, so a device in regular use stays signed in for good.
 * 400 days is the longest cookie lifetime browsers allow (Chrome caps it).
 */
export const SESSION_TTL_DAYS = 400;
/** Refresh the expiry at most this often, so most requests skip the write. */
export const SESSION_REFRESH_HOURS = 24;

/**
 * Mock sign-in replaces Google with a local "pick a user" page. It is on in
 * dev when AUTH_MOCK=1 or when no Google client id is configured, and it can
 * never be on in a production build.
 */
export function mockAuthEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.AUTH_MOCK === "1" || !process.env.GOOGLE_CLIENT_ID;
}

/** Public origin of the app, for the OAuth redirect URI. */
export function appOrigin(req: Request): string {
  return process.env.APP_URL?.replace(/\/+$/, "") || new URL(req.url).origin;
}

export function secureCookies(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Only same-site paths are allowed as post-sign-in destinations. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

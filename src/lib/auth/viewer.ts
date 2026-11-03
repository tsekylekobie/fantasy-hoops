// Who is viewing, for server components and routes. League data (rosters, owners,
// waivers, matchups, standings, transactions) is private: signed out, only
// League (an empty state), Players and Box scores are open, without league info.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { SESSION_COOKIE } from "./config";
import { getSession, type CurrentSession } from "./session";

/** This request's session (looked up once per request), or null when signed out. */
export const currentSession = cache(async (): Promise<CurrentSession | null> =>
  getSession((await cookies()).get(SESSION_COOKIE)?.value));

/** For league-only pages: the session, or a redirect to /league (which asks to sign in). */
export async function requireSignedInPage(): Promise<CurrentSession> {
  const session = await currentSession();
  if (!session) redirect("/league");
  return session;
}

// Database-backed sessions: one random token per device, stored hashed.
import { createHash, randomBytes } from "node:crypto";
import type { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import type { SessionUser } from "@/lib/types";
import { SESSION_COOKIE, SESSION_REFRESH_HOURS, SESSION_TTL_DAYS, secureCookies } from "./config";

export interface Profile {
  /** Google's `sub`, or "mock:<email>" for mock sign-ins. */
  googleSub: string;
  email: string;
  name: string;
  pictureUrl: string | null;
}

const TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** Inserts or refreshes the user and returns their id. */
export async function upsertUser(p: Profile): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (google_sub, email, name, picture_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (google_sub) DO UPDATE
       SET email = EXCLUDED.email, name = EXCLUDED.name,
           picture_url = EXCLUDED.picture_url, last_seen_at = now()
     RETURNING id`,
    [p.googleSub, p.email, p.name, p.pictureUrl],
  );
  return Number(rows[0].id);
}

/** Starts a session for this device and sets its cookie on `res`. */
export async function startSession(res: NextResponse, userId: number, userAgent: string | null): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, user_agent, expires_at) VALUES ($1, $2, $3, $4)`,
    [hashToken(token), userId, userAgent?.slice(0, 500) ?? null, new Date(Date.now() + TTL_MS)],
  );
  setSessionCookie(res, token);
}

function setSessionCookie(res: NextResponse, token: string): void {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: TTL_MS / 1000,
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: secureCookies(), sameSite: "lax", path: "/", maxAge: 0 });
}

export interface CurrentSession {
  user: SessionUser;
  /** True when the expiry is due to slide forward (see refreshSession). */
  stale: boolean;
}

/** Looks up the session for a cookie token; null if missing or expired. */
export async function getSession(token: string | undefined): Promise<CurrentSession | null> {
  if (!token) return null;
  const { rows } = await pool.query<{
    id: string;
    email: string;
    name: string;
    picture_url: string | null;
    stale: boolean;
  }>(
    `SELECT u.id, u.email, u.name, u.picture_url,
            s.last_used_at < now() - make_interval(hours => $2) AS stale
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token), SESSION_REFRESH_HOURS],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    user: { id: Number(r.id), email: r.email, name: r.name, pictureUrl: r.picture_url },
    stale: r.stale,
  };
}

/** Slides the session's expiry forward and re-issues the cookie with it. */
export async function refreshSession(res: NextResponse, token: string): Promise<void> {
  await pool.query(
    `UPDATE sessions SET last_used_at = now(), expires_at = $2 WHERE token_hash = $1`,
    [hashToken(token), new Date(Date.now() + TTL_MS)],
  );
  setSessionCookie(res, token);
}

export async function endSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}

// Database-backed sessions: one random token per device, stored hashed.
import { createHash, randomBytes } from "node:crypto";
import type { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import type { SessionUser } from "@/lib/types";
import { SESSION_COOKIE, SESSION_REFRESH_HOURS, SESSION_TTL_DAYS, secureCookies } from "./config";

export interface Profile {
  provider: "google" | "mock";
  /** The provider's stable account id (the ID token's `sub`); the email for mock sign-ins. */
  subject: string;
  email: string;
  /** Whether the provider vouches for the email. Only a verified email links league teams. */
  emailVerified: boolean;
  name: string;
  pictureUrl: string | null;
}

const TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/**
 * Finds or creates the user for this provider account and refreshes their
 * profile; returns their id. A provider account seen for the first time joins
 * an existing user when both verified the same email (so two sign-in methods with
 * one address are one user), else starts a new one.
 */
export async function signInUser(p: Profile): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serializes first sign-ins of the same account (and of the same email).
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`signin:${p.email.toLowerCase()}`]);
    let userId: string | undefined = (
      await client.query<{ user_id: string }>(
        `SELECT user_id FROM user_identities WHERE provider = $1 AND subject = $2`,
        [p.provider, p.subject],
      )
    ).rows[0]?.user_id;

    if (!userId && p.emailVerified) {
      userId = (
        await client.query<{ user_id: string }>(
          `SELECT i.user_id FROM user_identities i JOIN users u ON u.id = i.user_id
            WHERE i.email_verified AND lower(i.email) = lower($1)
            ORDER BY u.last_seen_at DESC LIMIT 1`,
          [p.email],
        )
      ).rows[0]?.user_id;
    }
    if (!userId) {
      userId = (
        await client.query<{ id: string }>(
          `INSERT INTO users (email, name, picture_url) VALUES ($1, $2, $3) RETURNING id`,
          [p.email, p.name, p.pictureUrl],
        )
      ).rows[0].id;
    }

    await client.query(
      `INSERT INTO user_identities (provider, subject, user_id, email, email_verified)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider, subject) DO UPDATE
         SET email = EXCLUDED.email, email_verified = EXCLUDED.email_verified, last_used_at = now()`,
      [p.provider, p.subject, userId, p.email, p.emailVerified],
    );
    await client.query(
      `UPDATE users SET email = $2, name = $3, picture_url = COALESCE($4, picture_url), last_seen_at = now()
        WHERE id = $1`,
      [userId, p.email, p.name, p.pictureUrl],
    );
    await client.query("COMMIT");
    return Number(userId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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

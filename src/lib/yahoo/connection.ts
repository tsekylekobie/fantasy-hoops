// The stored Yahoo connection (yahoo_connection, one row): tokens encrypted at
// rest (crypto.ts), a fresh access token on demand, sync bookkeeping, and who
// may manage it.
import type { Pool, PoolClient } from "pg";
import { CURRENT_SEASON, type YahooStatusResponse } from "../types";
import { decryptToken, encryptToken } from "./crypto";
import { refreshYahooTokens, yahooConfigured, type FetchFn, type YahooTokens } from "./oauth";

type Db = Pool | PoolClient;

export interface YahooConnection {
  leagueKey: string | null;
  connectedByUserId: number | null;
  connectedByName: string | null;
  redirectUri: string;
  connectedAt: Date;
  cache: YahooCache | null;
  lastRefreshAt: Date | null;
  lastRostersAt: Date | null;
  lastScoreboardAt: Date | null;
  lastFullAt: Date | null;
  lastWeek: number | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  throttledUntil: Date | null;
}

/** The last full sync's raw responses, so lighter passes can still build a whole snapshot. */
export interface YahooCache {
  settings: unknown;
  teams: unknown;
  gameWeeks: unknown;
}

export async function getConnection(db: Db): Promise<YahooConnection | null> {
  const { rows: [r] } = await db.query(
    `SELECT c.*, u.name AS connected_by_name FROM yahoo_connection c LEFT JOIN users u ON u.id = c.connected_by_user_id WHERE c.id = 1`,
  );
  if (!r) return null;
  return {
    leagueKey: r.league_key,
    connectedByUserId: r.connected_by_user_id === null ? null : Number(r.connected_by_user_id),
    connectedByName: r.connected_by_name,
    redirectUri: r.redirect_uri,
    connectedAt: r.connected_at,
    cache: r.cache,
    lastRefreshAt: r.last_refresh_at,
    lastRostersAt: r.last_rosters_at,
    lastScoreboardAt: r.last_scoreboard_at,
    lastFullAt: r.last_full_at,
    lastWeek: r.last_week,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
    throttledUntil: r.throttled_until,
  };
}

/** After the OAuth callback: (re)connects, keeping the chosen league unless it's another Yahoo account. */
export async function saveConnection(db: Db, tokens: YahooTokens, userId: number, redirectUri: string): Promise<void> {
  if (!tokens.refreshToken) throw new Error("Yahoo sent no refresh token");
  await db.query(
    `INSERT INTO yahoo_connection (id, connected_by_user_id, yahoo_guid, redirect_uri, refresh_token_enc, access_token_enc, access_expires_at, connected_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (id) DO UPDATE SET
       league_key = CASE WHEN yahoo_connection.yahoo_guid IS NULL OR yahoo_connection.yahoo_guid = EXCLUDED.yahoo_guid THEN yahoo_connection.league_key END,
       connected_by_user_id = EXCLUDED.connected_by_user_id, yahoo_guid = EXCLUDED.yahoo_guid,
       redirect_uri = EXCLUDED.redirect_uri, refresh_token_enc = EXCLUDED.refresh_token_enc,
       access_token_enc = EXCLUDED.access_token_enc, access_expires_at = EXCLUDED.access_expires_at,
       connected_at = now(), last_error = NULL, last_error_at = NULL, throttled_until = NULL`,
    [userId, tokens.guid, redirectUri, encryptToken(tokens.refreshToken), encryptToken(tokens.accessToken), tokens.expiresAt],
  );
}

export async function setLeagueKey(db: Db, leagueKey: string): Promise<void> {
  // A different league starts over: its first sync is a full one.
  await db.query(
    `UPDATE yahoo_connection SET league_key = $1, cache = NULL, last_full_at = NULL, last_scoreboard_at = NULL, last_week = NULL
      WHERE id = 1 AND league_key IS DISTINCT FROM $1`,
    [leagueKey],
  );
}

export async function disconnect(db: Db): Promise<void> {
  await db.query(`DELETE FROM yahoo_connection WHERE id = 1`);
}

/**
 * A valid access token: the stored one, or a new one from the refresh token
 * when it's expired (or `force`, after Yahoo answered 401). Refreshes are
 * serialized with a row lock, so the web app and the worker don't both refresh.
 */
export async function getAccessToken(pool: Pool, force = false, fetchFn?: FetchFn): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [r] } = await client.query<{ refresh_token_enc: string; access_token_enc: string | null; access_expires_at: Date | null; redirect_uri: string; fresh: boolean }>(
      `SELECT refresh_token_enc, access_token_enc, access_expires_at, redirect_uri,
              access_token_enc IS NOT NULL AND access_expires_at > now() AS fresh
         FROM yahoo_connection WHERE id = 1 FOR UPDATE`,
    );
    if (!r) throw new Error("Yahoo isn't connected");
    if (r.fresh && !force) {
      await client.query("COMMIT");
      return decryptToken(r.access_token_enc!);
    }
    let tokens: YahooTokens;
    try {
      tokens = await refreshYahooTokens(decryptToken(r.refresh_token_enc), r.redirect_uri, fetchFn);
    } catch (err) {
      throw new Error(`Couldn't refresh the Yahoo connection (reconnect at /league/yahoo if this keeps up): ${(err as Error).message}`);
    }
    await client.query(
      `UPDATE yahoo_connection SET access_token_enc = $1, access_expires_at = $2, refresh_token_enc = coalesce($3, refresh_token_enc) WHERE id = 1`,
      [encryptToken(tokens.accessToken), tokens.expiresAt, tokens.refreshToken && encryptToken(tokens.refreshToken)],
    );
    await client.query("COMMIT");
    return tokens.accessToken;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Who the viewer is to the league: a member (owns a team or is commissioner) and whether they may manage the connection. */
export async function yahooRole(db: Db, userId: number): Promise<{ member: boolean; admin: boolean }> {
  const { rows: [r] } = await db.query<{ league: boolean; commissioner: boolean; has_commissioner: boolean; owns: boolean }>(
    `SELECT l.id IS NOT NULL AS league,
            coalesce(l.commissioner_user_id = $2, false) AS commissioner,
            l.commissioner_user_id IS NOT NULL AS has_commissioner,
            EXISTS (SELECT 1 FROM fantasy_teams ft WHERE ft.league_id = l.id AND ft.owner_user_id = $2) AS owns
       FROM (SELECT 1) one LEFT JOIN LATERAL (SELECT * FROM leagues WHERE season = $1 ORDER BY id LIMIT 1) l ON true`,
    [CURRENT_SEASON, userId],
  );
  const member = r.commissioner || r.owns;
  // No league yet (a fresh install): any signed-in user can connect, to bring it in.
  // A league without a commissioner: any of its managers.
  const admin = r.commissioner || !r.league || (!r.has_commissioner && member);
  return { member: member || !r.league, admin };
}

/** Claims the once-a-minute manual refresh for the league; false when someone refreshed less than a minute ago. */
export async function claimManualRefresh(db: Db): Promise<{ ok: true } | { ok: false; retryInSeconds: number }> {
  const { rowCount } = await db.query(
    `UPDATE yahoo_connection SET manual_refresh_at = now()
      WHERE id = 1 AND (manual_refresh_at IS NULL OR manual_refresh_at <= now() - interval '1 minute')`,
  );
  if (rowCount) return { ok: true };
  const { rows: [r] } = await db.query<{ s: number }>(
    `SELECT greatest(1, ceil(extract(epoch FROM manual_refresh_at + interval '1 minute' - now())))::int AS s FROM yahoo_connection WHERE id = 1`,
  );
  return { ok: false, retryInSeconds: r?.s ?? 60 };
}

/** GET /api/yahoo/status and /league/yahoo: the connection as a league member sees it. */
export async function statusFor(db: Db, canManage: boolean): Promise<YahooStatusResponse> {
  const c = await getConnection(db);
  const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
  return {
    configured: yahooConfigured(),
    connected: !!c,
    leagueKey: c?.leagueKey ?? null,
    connectedBy: c?.connectedByName ?? null,
    connectedAt: iso(c?.connectedAt),
    lastRefreshAt: iso(c?.lastRefreshAt),
    lastError: c?.lastError ?? null,
    lastErrorAt: iso(c?.lastErrorAt),
    throttledUntil: c?.throttledUntil && c.throttledUntil > new Date() ? c.throttledUntil.toISOString() : null,
    canManage,
  };
}

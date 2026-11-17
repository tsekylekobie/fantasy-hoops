// Mirrors the Yahoo league into ours: fetch (api.ts), read (fromApi.ts), write
// (apply.ts, in place). Run by the worker's `yahoo` task, POST /api/yahoo/refresh
// and npm run yahoo:sync. Three sizes of pass:
//   rosters     every YAHOO_REFRESH_MINUTES (default 5): today's roster for every
//               team and the latest transactions (teams + 1 calls).
//   scoreboard  hourly, and on a manual refresh: also the teams (waiver order,
//               FAAB), the current week's scoreboard (live totals, week_results
//               final = false) and every team's lineup for the rest of the week.
//   full        daily and when a week ends: also the settings, the weeks, the
//               standings, every week's scoreboard not yet final here, and all
//               transactions.
// No connection, or no league chosen: nothing to do. Every pass records
// last_refresh_at or last_error on the connection; when Yahoo throttles, the
// sync stops calling for 15 minutes (an hour if it happens again soon after).
import type { Pool } from "pg";
import { CURRENT_SEASON } from "../types";
import { createYahooClient, YahooThrottled, type YahooClient } from "./api";
import { applySnapshot, type ApplyReport } from "./apply";
import { getAccessToken, getConnection, setLeagueKey, type YahooCache, type YahooConnection } from "./connection";
import { leagueMeta, snapshotFromApi, transactionCount, userLeaguesFromApi, weeksFromApi, type ApiResponses } from "./fromApi";
import type { FetchFn } from "./oauth";

const MIN = 60_000;
const HOUR = 60 * MIN;
export const REFRESH_MS = Math.max(1, Number(process.env.YAHOO_REFRESH_MINUTES) || 5) * MIN;
const SCOREBOARD_MS = HOUR;
const FULL_MS = 24 * HOUR;
const TX_PAGE = 25;
// Any constant; one sync writes at a time (worker and manual refresh).
const LOCK_KEY = 727_031_025;

export type SyncScope = "rosters" | "scoreboard" | "full";

export interface SyncOptions {
  /** "auto" (default): the cadence above. Otherwise at least this much. */
  scope?: SyncScope | "auto";
  /** Rebuild the league from scratch (apply.ts replace mode). */
  replace?: boolean;
  /** Fetch and apply, then roll back. */
  dryRun?: boolean;
  /** For tests and --fixtures. */
  fetch?: FetchFn;
  /** Milliseconds between Yahoo calls (default 300). */
  minIntervalMs?: number;
}

export interface SyncResult {
  status: "ok" | "not_connected" | "no_league" | "throttled" | "failed";
  scope: SyncScope | null;
  summary: string;
  requests: number;
  report: ApplyReport | null;
  /** When there's no league yet: the connected account's leagues this season, to pick from. */
  leagues?: { key: string; name: string; season: number }[];
  /** When the worker should come back. */
  nextInMs: number;
}

const DAY = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

function localDate(timeZone: string, at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Which pass is due (pure): see the top of the file. */
export function dueScope(c: Pick<YahooConnection, "cache" | "lastFullAt" | "lastScoreboardAt" | "lastWeek">, currentWeek: number | null, nowMs: number): SyncScope {
  if (!c.cache || !c.lastFullAt || nowMs - c.lastFullAt.getTime() >= FULL_MS) return "full";
  if (currentWeek !== null && c.lastWeek !== null && currentWeek !== c.lastWeek) return "full";
  if (!c.lastScoreboardAt || nowMs - c.lastScoreboardAt.getTime() >= SCOREBOARD_MS) return "scoreboard";
  return "rosters";
}

const RANK: Record<SyncScope, number> = { rosters: 0, scoreboard: 1, full: 2 };

function client(db: Pool, opts: SyncOptions): YahooClient {
  return createYahooClient((force) => getAccessToken(db, force, opts.fetch), { fetch: opts.fetch, minIntervalMs: opts.minIntervalMs });
}

/** The connected account's NBA leagues this season. */
export async function fetchUserLeagues(db: Pool, opts: SyncOptions = {}): Promise<{ key: string; name: string; season: number }[]> {
  const json = await client(db, opts).get("users;use_login=1/games;game_codes=nba/leagues");
  return userLeaguesFromApi(json).filter((l) => l.season === CURRENT_SEASON);
}

export async function syncYahoo(db: Pool, opts: SyncOptions = {}): Promise<SyncResult> {
  const conn = await getConnection(db);
  const base = { scope: null, requests: 0, report: null };
  if (!conn) return { ...base, status: "not_connected", summary: "not connected", nextInMs: REFRESH_MS };
  const now = Date.now();
  if (conn.throttledUntil && conn.throttledUntil.getTime() > now) {
    const ms = conn.throttledUntil.getTime() - now;
    return { ...base, status: "throttled", summary: `Yahoo throttled us; waiting ${Math.ceil(ms / MIN)} min`, nextInMs: ms };
  }

  const api = client(db, opts);
  let scope: SyncScope | null = null;
  try {
    let leagueKey = conn.leagueKey;
    if (!leagueKey) {
      const leagues = userLeaguesFromApi(await api.get("users;use_login=1/games;game_codes=nba/leagues")).filter((l) => l.season === CURRENT_SEASON);
      if (leagues.length !== 1) {
        return {
          ...base, status: "no_league", requests: api.requestCount, leagues, nextInMs: REFRESH_MS,
          summary: leagues.length === 0 ? `the Yahoo account has no ${CURRENT_SEASON} NBA league` : `pick one of ${leagues.length} leagues at /league/yahoo`,
        };
      }
      leagueKey = leagues[0].key;
      await setLeagueKey(db, leagueKey);
      conn.cache = null;
    }

    const { rows: [l] } = await db.query<{ time_zone: string }>(`SELECT time_zone FROM leagues WHERE season = $1 ORDER BY id LIMIT 1`, [CURRENT_SEASON]);
    const timeZone = l?.time_zone ?? "America/New_York";
    const today = localDate(timeZone);

    // Which pass: from the cached weeks, is it a new week since the last full sync?
    let cachedCurrent: number | null = null;
    if (conn.cache) {
      const m = leagueMeta(conn.cache.settings);
      cachedCurrent = weeksFromApi(conn.cache.gameWeeks, m.startWeek, m.endWeek).find((w) => w.start <= today && today <= w.end)?.week ?? null;
    }
    const due = dueScope(conn, cachedCurrent, now);
    const asked = opts.scope && opts.scope !== "auto" ? opts.scope : "rosters";
    scope = opts.replace ? "full" : RANK[asked] > RANK[due] ? asked : due;
    const full = scope === "full";
    const hourly = scope !== "rosters";

    // --- Fetch ---
    const settings = full || !conn.cache ? await api.get(`league/${leagueKey}/settings`) : conn.cache.settings;
    const meta = leagueMeta(settings);
    const gameWeeks = full || !conn.cache ? await api.get(`game/${meta.gameKey}/game_weeks`) : conn.cache.gameWeeks;
    const teams = hourly || !conn.cache ? await api.get(`league/${leagueKey}/teams`) : conn.cache.teams;
    const weeks = weeksFromApi(gameWeeks, meta.startWeek, meta.endWeek);
    const current = weeks.find((w) => w.start <= today && today <= w.end) ?? null;
    const r: ApiResponses = { settings, teams, gameWeeks, scoreboards: [], rosters: [], transactions: [] };
    if (full) r.standings = await api.get(`league/${leagueKey}/standings`);

    let scoreWeeks: number[] = [];
    if (full) {
      // Every week not already final here; future weeks only until they have pairings (playoffs: until they start).
      const { rows } = await db.query<{ week: number; finals: number; pairs: number }>(
        `SELECT w.week, (SELECT count(*)::int FROM week_results r WHERE r.league_id = w.league_id AND r.week = w.week AND r.final) AS finals,
                (SELECT count(*)::int FROM matchups m WHERE m.league_id = w.league_id AND m.week = w.week) AS pairs
           FROM league_weeks w JOIN leagues l ON l.id = w.league_id WHERE l.season = $1 AND l.yahoo_league_key = $2`,
        [CURRENT_SEASON, leagueKey],
      );
      const known = new Map(rows.map((x) => [x.week + meta.startWeek - 1, x]));
      const { rows: [{ n: teamCount }] } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM fantasy_teams ft JOIN leagues l ON l.id = ft.league_id WHERE l.season = $1`, [CURRENT_SEASON],
      );
      scoreWeeks = weeks.filter((w) => {
        const k = known.get(w.week);
        if (opts.replace || !k) return true;
        if (w.end < today) return k.finals < teamCount || k.pairs === 0;
        if (w.start <= today) return true;
        return k.pairs === 0 || w.start <= DAY(today, 7);
      }).map((w) => w.week);
    } else if (hourly && current) {
      scoreWeeks = [current.week];
    }
    for (const w of scoreWeeks) r.scoreboards!.push(await api.get(`league/${leagueKey}/scoreboard;week=${w}`));

    const teamKeys = snapshotFromApi({ settings, teams }, today, "").snapshot.teams.map((t) => t.key);
    const days = [today];
    if (hourly && current) for (let d = DAY(today, 1); d <= current.end; d = DAY(d, 1)) days.push(d);
    for (const date of days) {
      for (const key of teamKeys) r.rosters!.push({ date, json: await api.get(`team/${key}/roster;date=${date}`) });
    }

    if (full) {
      const seen = new Set<string>();
      for (let start = 0; start < 2000; start += TX_PAGE) {
        const page = await api.get(`league/${leagueKey}/transactions;start=${start};count=${TX_PAGE}`);
        const keys = snapshotFromApi({ settings, teams, transactions: [page] }, today, "").snapshot.transactions.map((t) => t.id);
        r.transactions!.push(page);
        if (transactionCount(page) < TX_PAGE || keys.every((k) => seen.has(k))) break;
        for (const k of keys) seen.add(k);
      }
    } else {
      r.transactions!.push(await api.get(`league/${leagueKey}/transactions;count=${TX_PAGE}`));
    }

    // --- Apply ---
    const { snapshot, warnings } = snapshotFromApi(r, today, new Date().toISOString());
    const pg = await db.connect();
    let report: ApplyReport;
    try {
      await pg.query("BEGIN");
      await pg.query(`SELECT pg_advisory_xact_lock($1)`, [LOCK_KEY]);
      report = await applySnapshot(pg, snapshot, { mode: opts.replace ? "replace" : "upsert", source: "api" });
      report.warnings.unshift(...warnings);
      await pg.query(report.errors.length === 0 && !opts.dryRun ? "COMMIT" : "ROLLBACK");
    } catch (err) {
      await pg.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      pg.release();
    }

    if (report.errors.length > 0) {
      const msg = report.errors.join(" ");
      await recordError(db, msg);
      return { status: "failed", scope, summary: `${scope}: ${msg}`, requests: api.requestCount, report, nextInMs: REFRESH_MS };
    }
    if (!opts.dryRun) {
      const cache: YahooCache = { settings, teams, gameWeeks };
      await db.query(
        `UPDATE yahoo_connection SET cache = $1, last_refresh_at = now(), last_rosters_at = now(),
                last_scoreboard_at = CASE WHEN $2 THEN now() ELSE last_scoreboard_at END,
                last_full_at = CASE WHEN $3 THEN now() ELSE last_full_at END,
                last_week = CASE WHEN $3 THEN $4 ELSE last_week END,
                last_error = NULL, last_error_at = NULL
          WHERE id = 1`,
        [JSON.stringify(cache), hourly, full, current?.week ?? meta.currentWeek],
      );
    }
    return {
      status: "ok", scope, requests: api.requestCount, report, nextInMs: REFRESH_MS,
      summary: `${scope}${opts.dryRun ? " (dry run)" : ""}: ${days.length} day(s) of ${teamKeys.length} rosters, ${scoreWeeks.length} scoreboard(s)` +
        `${report.warnings.length ? `, ${report.warnings.length} warnings` : ""}`,
    };
  } catch (err) {
    if (err instanceof YahooThrottled) {
      const { rows: [t] } = await db.query<{ until: Date }>(
        `UPDATE yahoo_connection SET throttled_until = now() + CASE WHEN throttled_until > now() - interval '1 hour' THEN interval '1 hour' ELSE interval '15 minutes' END,
                last_error = $1, last_error_at = now() WHERE id = 1 RETURNING throttled_until AS until`,
        [err.message],
      );
      const ms = t ? t.until.getTime() - Date.now() : 15 * MIN;
      return { ...base, status: "throttled", scope, requests: api.requestCount, summary: `${err.message}; backing off ${Math.round(ms / MIN)} min`, nextInMs: ms };
    }
    const msg = err instanceof Error ? err.message : String(err);
    await recordError(db, msg);
    return { ...base, status: "failed", scope, requests: api.requestCount, summary: msg, nextInMs: REFRESH_MS };
  }
}

async function recordError(db: Pool, message: string): Promise<void> {
  await db.query(`UPDATE yahoo_connection SET last_error = $1, last_error_at = now() WHERE id = 1`, [message.slice(0, 2000)]);
}

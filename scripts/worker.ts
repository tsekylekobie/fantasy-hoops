// Long-running sync worker: keeps games, stat lines, injuries and players
// current so nobody has to run the backfill by hand (PLAN.md, "Refresh
// strategy"). Runs next to the app as its own process:
//   npm run worker            # loop forever
//   npm run worker -- --once  # run every task once and exit
//
// Tasks, each on its own cadence (one log line per pass):
//   live         While a game is live: games and stat lines every WORKER_LIVE_SECONDS
//                (default 120). Otherwise every 30 min, or just after the next tip-off.
//   injuries     Every 15 min on days with games, every 2 h otherwise.
//   corrections  Once a day after WORKER_CORRECTIONS_HOUR (default 9, league time):
//                the last 3 days of games and stat lines again, for stat corrections.
//   rosters      Every 12 h: teams, players, and the season's schedule.
//   lineups      Every 15 min and just after midnight (league time): saves each
//                team's lineup for every day through today, so past days stay
//                fixed even if the roster changes later. Then processes trades whose
//                review window has ended (they wait while a player is locked today).
//                Database only, no API.
//   waivers      At the league's waiver time (leagues.waiver_time in its time zone):
//                processes due claims and clears waivers (queries/waivers.ts). Each
//                daily run is recorded in waiver_runs, so it happens exactly once
//                even across restarts; a worker that was down runs the missed one.
//
// Safe to restart: every pass is an idempotent upsert, and each task's last
// run is kept in sync_state ("worker:<task>") so a restart doesn't redo the
// slow ones. All API calls share one client, so the RPM limit holds across
// tasks. Lineup locks read games.status_state and games.datetime, which this
// keeps fresh; the only lineup writes are the lineups task's (freezeLineups).
import "dotenv/config";
import { Pool } from "pg";
import { createClient } from "../src/lib/bdl";
import { freezeSeasonLineups } from "../src/lib/queries/lineup";
import { processDueTrades } from "../src/lib/queries/trades";
import { processDueWaivers } from "../src/lib/queries/waivers";
import { CURRENT_SEASON } from "../src/lib/types";
import { getState, log, saveState, syncGames, syncInjuries, syncStats, syncTeamsAndPlayers } from "./lib/sync";
import { classifyGames, upsertGames } from "./lib/upsert";

const MIN = 60_000;
const HOUR = 60 * MIN;
const TZ = process.env.WORKER_TIME_ZONE ?? "America/New_York";
const LIVE_MS = Number(process.env.WORKER_LIVE_SECONDS ?? 120) * 1000;
const CORRECTIONS_HOUR = Number(process.env.WORKER_CORRECTIONS_HOUR ?? 9);
const IDLE_MS = 30 * MIN;
const RETRY_MS = 2 * MIN;
const TICK_MS = 5_000;
// Finished games keep getting their stat lines re-pulled this long after tip-off,
// since the provider can lag the final buzzer.
const RECENT_FINAL_HOURS = 5;

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const api = createClient();
const season = CURRENT_SEASON;

/** yyyy-mm-dd and hour of `t` in the league's time zone. */
function local(t = Date.now()): { date: string; hour: number; minute: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(t)).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Milliseconds until the next HH:00 in the league's time zone. */
function msUntilLocalHour(hour: number): number {
  const start = Math.ceil(Date.now() / MIN) * MIN;
  for (let t = start; t < start + 26 * HOUR; t += MIN) {
    const l = local(t);
    if (l.hour === hour && l.minute === 0) return t - Date.now();
  }
  return 24 * HOUR;
}

function fmtMs(ms: number): string {
  return ms >= HOUR ? `${(ms / HOUR).toFixed(1)}h` : ms >= MIN ? `${Math.round(ms / MIN)}m` : `${Math.round(ms / 1000)}s`;
}

// A game counts as live once the provider says so, or once its tip-off has
// passed (the provider can be slow to flip it), until it's final.
const LIVE_SQL = `NOT g.postponed AND coalesce(g.status_state, '') <> 'final'
  AND (coalesce(g.status_state, 'scheduled') <> 'scheduled' OR g.datetime <= now())`;

interface Result {
  summary: string;
  nextInMs: number;
}

/** Games for yesterday and today (league time), then stat lines for games live or just finished. */
async function live(): Promise<Result> {
  const today = local().date;
  const dates = [addDays(today, -1), today];
  let games = 0;
  for await (const page of api.games({ dates })) games += await upsertGames(db, page.items);

  const { rows: ids } = await db.query<{ id: number }>(
    `SELECT g.id FROM games g
      WHERE g.date = ANY($1::date[])
        AND ((${LIVE_SQL})
          OR (g.status_state = 'final' AND g.datetime > now() - make_interval(hours => $2)))`,
    [dates, RECENT_FINAL_HOURS],
  );
  const lines = await syncStats(db, api, { gameIds: ids.map((r) => r.id) });

  const { rows: [s] } = await db.query<{ live: number; next_tip: Date | null }>(
    `SELECT (SELECT count(*)::int FROM games g WHERE g.date = ANY($1::date[]) AND ${LIVE_SQL}) AS live,
            (SELECT min(g.datetime) FROM games g
              WHERE g.datetime > now() AND NOT g.postponed AND coalesce(g.status_state, '') <> 'final') AS next_tip`,
    [dates],
  );
  let nextInMs = LIVE_MS;
  if (s.live === 0) {
    // Idle: check back at the next tip-off (plus a minute) or in 30 min, whichever is first.
    const untilTip = s.next_tip ? s.next_tip.getTime() - Date.now() + MIN : Infinity;
    nextInMs = Math.max(LIVE_MS, Math.min(IDLE_MS, untilTip));
  }
  return { summary: `${s.live} live, ${games} games, ${lines} stat lines for ${ids.length} games`, nextInMs };
}

async function injuries(): Promise<Result> {
  const { reported, changed } = await syncInjuries(db, api);
  const { rows: [g] } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM games WHERE date = $1 AND NOT postponed`,
    [local().date],
  );
  return { summary: `${reported} on the report, ${changed} changed`, nextInMs: g.n > 0 ? 15 * MIN : 2 * HOUR };
}

/** The last three days again, for stat corrections; once a day after CORRECTIONS_HOUR. */
async function corrections(): Promise<Result> {
  const today = local().date;
  const dates = [addDays(today, -3), addDays(today, -2), addDays(today, -1)];
  let games = 0;
  for await (const page of api.games({ dates })) games += await upsertGames(db, page.items);
  const lines = await syncStats(db, api, { dates });
  const cls = await classifyGames(db, season);
  return {
    summary: `${games} games, ${lines} stat lines (${dates[0]} to ${dates[2]}), ${cls.playIn} play-in, ${cls.cupFinal} cup-final`,
    nextInMs: msUntilLocalHour(CORRECTIONS_HOUR),
  };
}

async function rosters(): Promise<Result> {
  const { teams, players } = await syncTeamsAndPlayers(db, api);
  const games = await syncGames(db, api, { seasons: [season] });
  await classifyGames(db, season);
  return { summary: `${teams} teams, ${players} players, ${games} games in the ${season} schedule`, nextInMs: 12 * HOUR };
}

/** Saves every team's lineup through today (league time), then processes due trades; see freezeLineups. */
async function lineups(): Promise<Result> {
  const { teams, rows } = await freezeSeasonLineups(db, season);
  const trades = await processDueTrades(db);
  // Right after midnight too, so a new day is pinned before anyone changes a roster.
  const nextInMs = Math.min(15 * MIN, msUntilLocalHour(0) + MIN);
  return {
    summary: `${rows} lineup rows saved for ${teams} teams; trades: ${trades.completed} processed, ` +
      `${trades.failed} failed, ${trades.waiting} waiting on locks`,
    nextInMs,
  };
}

/** The latest daily waiver run, if it hasn't happened; then sleeps until the next. */
async function waivers(): Promise<Result> {
  const { run, nextRunAt } = await processDueWaivers(db, season);
  // Re-check at least every 15 min in case the league's waiver time changes.
  const nextInMs = nextRunAt ? Math.min(15 * MIN, Math.max(5_000, nextRunAt.getTime() - Date.now() + 5_000)) : HOUR;
  const summary = !nextRunAt
    ? "no league"
    : run
      ? `${run.claims} claims, ${run.won} won, ${run.failed} failed, ${run.cleared} cleared${run.log.length ? ` (${run.log.join("; ")})` : ""}`
      : "already ran";
  return { summary, nextInMs };
}

interface Task {
  name: string;
  run: () => Promise<Result>;
  /** When the first run is due, given the last completed run (null if never). */
  firstDue: (last: Date | null) => number;
  nextAt: number;
}

const now = () => Date.now();
const TASKS: Task[] = [
  // Live first: it's the one people are watching, and a rosters pass takes about a minute.
  { name: "live", run: live, firstDue: () => now(), nextAt: 0 },
  { name: "injuries", run: injuries, firstDue: (last) => (last ? last.getTime() + 15 * MIN : now()), nextAt: 0 },
  {
    name: "corrections",
    run: corrections,
    firstDue: (last) => {
      const l = local();
      const doneToday = last !== null && local(last.getTime()).date === l.date;
      return !doneToday && l.hour >= CORRECTIONS_HOUR ? now() : now() + msUntilLocalHour(CORRECTIONS_HOUR);
    },
    nextAt: 0,
  },
  { name: "rosters", run: rosters, firstDue: (last) => (last ? last.getTime() + 12 * HOUR : now()), nextAt: 0 },
  { name: "lineups", run: lineups, firstDue: () => now(), nextAt: 0 },
  { name: "waivers", run: waivers, firstDue: () => now(), nextAt: 0 },
];

let stopping = false;
let wake: (() => void) | null = null;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1); // second signal: don't wait for the current pass
    log(`${sig}: stopping after the current pass`);
    stopping = true;
    wake?.();
  });
}

async function runTask(t: Task): Promise<void> {
  const req0 = api.requestCount;
  const t0 = now();
  try {
    const r = await t.run();
    t.nextAt = now() + r.nextInMs;
    await saveState(db, `worker:${t.name}`, null, true, 0);
    log(`${t.name}: ${r.summary} · ${api.requestCount - req0} req, ${fmtMs(now() - t0)} · next in ${fmtMs(r.nextInMs)}`);
  } catch (err) {
    t.nextAt = now() + RETRY_MS;
    log(`${t.name}: FAILED after ${fmtMs(now() - t0)}: ${err instanceof Error ? err.message : String(err)} · retry in ${fmtMs(RETRY_MS)}`);
  }
}

async function main() {
  const once = process.argv.includes("--once");
  log(`worker: season ${season}, ${TZ}, live every ${fmtMs(LIVE_MS)}${once ? ", once" : ""}`);
  try {
    if (once) {
      for (const t of TASKS) if (!stopping) await runTask(t);
      return;
    }
    for (const t of TASKS) t.nextAt = t.firstDue((await getState(db, `worker:${t.name}`))?.completedAt ?? null);
    while (!stopping) {
      for (const t of TASKS) if (!stopping && t.nextAt <= now()) await runTask(t);
      const until = Math.min(...TASKS.map((t) => t.nextAt)) - now();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(TICK_MS, Math.min(until, MIN)));
        // A stop signal ends the wait at once; clearing the timer lets the process exit.
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  } finally {
    await db.end();
    log("worker: stopped");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

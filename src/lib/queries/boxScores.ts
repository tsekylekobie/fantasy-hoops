// Box scores for one date (/box-scores): every game's player lines, each
// line's one-game Value (value.ts, against the season's pool, with the
// viewer's punt weights) and where each stat ranks among every player who
// played that date. `rankDay` is pure (tested).
//
// Rules: a player is on a box score once he has a stat row for the game;
// 0 minutes = DNP (no ranks). In-progress games count with their stats so far.
// FG% and FT% rank by impact (makes above the pool's percentage, weighted by
// attempts: the category z), so 4/5 beats 1/1; no attempts, no rank. Fewer
// turnovers ranks higher.
import type { Pool } from "pg";
import type {
  BoxRank,
  BoxRankKey,
  BoxScoreGame,
  BoxScorePlayer,
  BoxScoresResponse,
  BoxScoreTeam,
  CategoryLine,
  CategoryWeights,
  RankTier,
} from "../types";
import { getOwners, getSeasonTotals } from "./players";
import { gameScorer, type GameScore } from "./value";
import { ISO, getWaiverStatus } from "./waiverStatus";
import { gamesInProgress } from "./live";

/** A line to rank: its stats and its game score. */
export interface RankInput {
  key: number;
  line: CategoryLine;
  score: GameScore;
}

const RANK_KEYS: BoxRankKey[] = ["pts", "fg3m", "reb", "ast", "stl", "blk", "fgPct", "ftPct", "tov", "value"];

function rankScore(r: RankInput, k: BoxRankKey): number | null {
  switch (k) {
    case "value":
      return r.score.value;
    case "fgPct":
      return r.line.fga > 0 ? r.score.z.fgPct : null;
    case "ftPct":
      return r.line.fta > 0 ? r.score.z.ftPct : null;
    case "tov":
      return -r.line.tov;
    default:
      return r.line[k];
  }
}

/** Tier from a place between 0 (best) and 1 (worst). */
export function tierOf(place: number): RankTier {
  if (place <= 0.1) return "top10";
  if (place <= 0.25) return "top25";
  if (place <= 0.4) return "top40";
  if (place >= 0.9) return "bottom10";
  if (place >= 0.75) return "bottom25";
  return "mid";
}

/**
 * Ranks every line in each category and Value. Ties share the best rank, and
 * their place (for the tier) is the middle of the tie, so twenty players with
 * 0 blocks don't all count as the best or worst of them.
 */
export function rankDay(lines: RankInput[]): Map<number, Partial<Record<BoxRankKey, BoxRank>>> {
  const out = new Map<number, Partial<Record<BoxRankKey, BoxRank>>>(lines.map((l) => [l.key, {}]));
  for (const k of RANK_KEYS) {
    const scored = lines
      .map((l) => ({ key: l.key, s: rankScore(l, k) }))
      .filter((x): x is { key: number; s: number } => x.s !== null)
      .sort((a, b) => b.s - a.s);
    const n = scored.length;
    for (let i = 0; i < n; ) {
      let j = i;
      while (j + 1 < n && scored[j + 1].s === scored[i].s) j++;
      const tier = tierOf(n > 1 ? (i + j) / 2 / (n - 1) : 0);
      for (let m = i; m <= j; m++) out.get(scored[m].key)![k] = { rank: i + 1, tied: j > i, tier };
      i = j + 1;
    }
  }
  return out;
}

interface GameRow {
  id: number;
  status: string | null;
  status_state: string | null;
  period: number | null;
  time: string | null;
  tipoff: string | null;
  postponed: boolean;
  started: boolean;
  home_team_id: number;
  visitor_team_id: number;
  home_abbr: string;
  visitor_abbr: string;
  home_score: number | null;
  visitor_score: number | null;
}

interface StatRow {
  game_id: number;
  team_id: number;
  player_id: number;
  first_name: string;
  last_name: string;
  position: string | null;
  min: number;
  fgm: number;
  fga: number;
  ftm: number;
  fta: number;
  fg3m: number;
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
}

// $1 date
const GAMES_SQL = `
  SELECT g.id, g.status, g.status_state, g.period, g.time, ${ISO("g.datetime")} AS tipoff, g.postponed,
         coalesce(g.status_state <> 'scheduled' OR g.datetime <= now(), false) AS started,
         g.home_team_id, g.visitor_team_id, ht.abbreviation AS home_abbr, vt.abbreviation AS visitor_abbr,
         g.home_team_score AS home_score, g.visitor_team_score AS visitor_score
  FROM games g
  JOIN teams ht ON ht.id = g.home_team_id
  JOIN teams vt ON vt.id = g.visitor_team_id
  WHERE g.date = $1::date
  ORDER BY g.datetime NULLS LAST, g.id`;

const STATS_SQL = `
  SELECT s.game_id, s.team_id, s.player_id, p.first_name, p.last_name, nullif(p.position, '') AS position,
         coalesce(s.min, 0)::float8 AS min,
         coalesce(s.fgm, 0)::int AS fgm, coalesce(s.fga, 0)::int AS fga,
         coalesce(s.ftm, 0)::int AS ftm, coalesce(s.fta, 0)::int AS fta,
         coalesce(s.fg3m, 0)::int AS fg3m, coalesce(s.pts, 0)::int AS pts,
         coalesce(s.reb, 0)::int AS reb, coalesce(s.ast, 0)::int AS ast,
         coalesce(s.stl, 0)::int AS stl, coalesce(s.blk, 0)::int AS blk,
         coalesce(s.turnover, 0)::int AS tov
  FROM player_game_stats s
  JOIN games g ON g.id = s.game_id
  JOIN players p ON p.id = s.player_id
  WHERE g.date = $1::date`;

// $1 season, $2 user (null = signed out), $3 date. The league's today and time zone,
// the season's date range, the week strip's game counts, your team and its players' NBA teams.
const CONTEXT_SQL = `
  WITH l AS (SELECT id, time_zone FROM leagues WHERE season = $1 ORDER BY id DESC LIMIT 1),
       my AS (SELECT ft.id FROM fantasy_teams ft JOIN l ON ft.league_id = l.id WHERE ft.owner_user_id = $2)
  SELECT coalesce((SELECT time_zone FROM l), 'America/New_York') AS time_zone,
         to_char((now() AT TIME ZONE coalesce((SELECT time_zone FROM l), 'America/New_York'))::date, 'YYYY-MM-DD') AS today,
         (SELECT to_char(min(date), 'YYYY-MM-DD') FROM games WHERE season = $1) AS first_date,
         (SELECT to_char(max(date), 'YYYY-MM-DD') FROM games WHERE season = $1) AS last_date,
         (SELECT id::int FROM my) AS my_team_id,
         (SELECT coalesce(json_agg(json_build_object('date', to_char(d, 'YYYY-MM-DD'),
                   'games', (SELECT count(*) FROM games g WHERE g.date = d::date)) ORDER BY d), '[]')
            FROM generate_series($3::date - 3, $3::date + 3, interval '1 day') d) AS days,
         (SELECT coalesce(json_agg(json_build_object('name', p.first_name || ' ' || p.last_name, 'teamId', p.team_id)
                   ORDER BY p.last_name, p.first_name), '[]')
            FROM roster_players rp JOIN players p ON p.id = rp.player_id
           WHERE rp.fantasy_team_id = (SELECT id FROM my)) AS my_players`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** "Final", "Final/OT", "Final/2OT"; live: the clock ("Q4 5:06") or "Halftime". */
function statusText(g: GameRow): string | null {
  if (g.status_state === "final") {
    const ot = (g.period ?? 4) - 4;
    return ot <= 0 ? "Final" : ot === 1 ? "Final/OT" : `Final/${ot}OT`;
  }
  if (!g.started) return null;
  const clock = g.time?.trim();
  // Scheduled games carry their tip-off timestamp in `status`/`time`; skip those.
  if (clock && !/^\d{4}-\d{2}-\d{2}T/.test(clock)) return /^half/i.test(clock) ? "Halftime" : clock;
  return g.status && !/^\d{4}-\d{2}-\d{2}T/.test(g.status) ? g.status : "Live";
}

function emptyTotals(): CategoryLine & { min: number } {
  return { min: 0, fgm: 0, fga: 0, fgPct: null, ftm: 0, fta: 0, ftPct: null, fg3m: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0 };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const pct = (m: number, a: number) => (a > 0 ? r3(m / a) : null);

function toLine(r: StatRow): CategoryLine & { min: number } {
  return {
    min: Math.round(r.min), fgm: r.fgm, fga: r.fga, fgPct: pct(r.fgm, r.fga), ftm: r.ftm, fta: r.fta, ftPct: pct(r.ftm, r.fta),
    fg3m: r.fg3m, pts: r.pts, reb: r.reb, ast: r.ast, stl: r.stl, blk: r.blk, tov: r.tov,
  };
}

export async function getBoxScores(
  db: Pool,
  season: number,
  userId: number | null,
  date: string | null,
  weights: CategoryWeights,
): Promise<BoxScoresResponse> {
  const { rows: [probe] } = await db.query<{ today: string }>(
    `SELECT to_char((now() AT TIME ZONE coalesce((SELECT time_zone FROM leagues WHERE season = $1 ORDER BY id DESC LIMIT 1),
                     'America/New_York'))::date, 'YYYY-MM-DD') AS today`,
    [season],
  );
  const day = date !== null && ISO_DATE.test(date) && !Number.isNaN(Date.parse(date)) ? date : probe.today;

  const [ctxRes, gamesRes, statsRes, seasonTotals, owners, waivers, anyLive] = await Promise.all([
    db.query<{
      time_zone: string; today: string; first_date: string | null; last_date: string | null; my_team_id: number | null;
      days: { date: string; games: number }[]; my_players: { name: string; teamId: number | null }[];
    }>(CONTEXT_SQL, [season, userId, day]),
    db.query<GameRow>(GAMES_SQL, [day]),
    db.query<StatRow>(STATS_SQL, [day]),
    getSeasonTotals(db, season),
    getOwners(db, season),
    getWaiverStatus(db, season),
    gamesInProgress(db),
  ]);
  const ctx = ctxRes.rows[0];
  const score = gameScorer(seasonTotals, weights);

  // Score and rank every line with minutes, across all games.
  const played = statsRes.rows.filter((r) => r.min > 0);
  const scores = new Map<number, GameScore>();
  const inputs: RankInput[] = played.map((r) => {
    const line = toLine(r);
    const s = score({
      playerId: r.player_id, gp: 1, min: r.min, fgm: r.fgm, fga: r.fga, ftm: r.ftm, fta: r.fta, fg3m: r.fg3m,
      pts: r.pts, reb: r.reb, ast: r.ast, stl: r.stl, blk: r.blk, tov: r.tov,
    });
    scores.set(r.player_id, s);
    return { key: r.player_id, line, score: s };
  });
  const ranks = rankDay(inputs);

  const team = (g: GameRow, home: boolean): BoxScoreTeam => {
    const teamId = home ? g.home_team_id : g.visitor_team_id;
    const rows = statsRes.rows.filter((r) => r.game_id === g.id && r.team_id === teamId);
    const totals = emptyTotals();
    const players: BoxScorePlayer[] = rows.map((r) => {
      const line = r.min > 0 ? toLine(r) : null;
      if (line) {
        totals.min += r.min;
        for (const k of ["fgm", "fga", "ftm", "fta", "fg3m", "pts", "reb", "ast", "stl", "blk", "tov"] as const) totals[k] += line[k];
      }
      return {
        id: r.player_id, firstName: r.first_name, lastName: r.last_name, position: r.position,
        owner: owners.get(r.player_id) ?? null, waiver: owners.has(r.player_id) ? null : waivers.players.get(r.player_id) ?? null,
        line, value: line ? Math.round(scores.get(r.player_id)!.value * 100) / 100 : null,
        ranks: line ? ranks.get(r.player_id) ?? {} : {},
      };
    });
    players.sort((a, b) =>
      a.value === null || b.value === null
        ? (a.value === null ? 1 : 0) - (b.value === null ? 1 : 0) || a.lastName.localeCompare(b.lastName)
        : b.value - a.value);
    totals.min = Math.round(totals.min);
    totals.fgPct = pct(totals.fgm, totals.fga);
    totals.ftPct = pct(totals.ftm, totals.fta);
    const started = g.started || g.status_state === "final";
    const scoreNow = home ? g.home_score : g.visitor_score;
    return {
      id: teamId, abbreviation: home ? g.home_abbr : g.visitor_abbr,
      score: started ? scoreNow ?? totals.pts : null, players, totals,
    };
  };

  const games: BoxScoreGame[] = gamesRes.rows.map((g) => ({
    id: g.id,
    state: g.postponed ? "postponed" : g.status_state === "final" ? "final" : g.started ? "live" : "scheduled",
    statusText: g.postponed ? "Postponed" : statusText(g),
    tipoff: g.tipoff,
    away: team(g, false),
    home: team(g, true),
    mine: ctx.my_players.filter((p) => p.teamId === g.home_team_id || p.teamId === g.visitor_team_id).map((p) => p.name),
  }));

  return {
    date: day,
    today: ctx.today,
    timeZone: ctx.time_zone,
    days: ctx.days,
    firstDate: ctx.first_date,
    lastDate: ctx.last_date,
    games,
    playerCount: played.length,
    myTeamId: ctx.my_team_id,
    // gamesInProgress also counts games that ended in the last few hours (their lines can still change).
    live: anyLive && (games.some((g) => g.state === "live") || day === ctx.today || day === addDays(ctx.today, -1)),
  };
}

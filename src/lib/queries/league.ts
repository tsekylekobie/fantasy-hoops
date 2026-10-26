// League standings and this week's scoreboard behind the /league page.
//
// Standings are each team's category record (W–L–T) over every regular-season
// week played: the finished weeks plus the current one's live score (playoff
// and toilet bowl weeks don't count). Each week is scored the same way as
// /matchup (queries/matchups.ts), on read. The Playoffs view is built in
// queries/playoffs.ts.
import type { Pool } from "pg";
import type {
  FantasyTeamSummary,
  LeagueOverview,
  LeagueTransaction,
  OtherMatchup,
  RecentTransactions,
  PlayerSummary,
  StandingsRow,
  TransactionMove,
  WaiverRunClaim,
  WaiverRunEntry,
} from "../types";
import { standingsOrder, winPct } from "../playoffs/bracket";
import { MATCHUP_ROWS_SQL, bracketTag, buildPlayoffsView, configOf, type BracketRow } from "./playoffs";
import { WEEKS_SQL, isRegularWeek, playoffStart, recordsFrom, scoreIn, startedWeekLines, type WeekRow } from "./standings";
import { toTeamSummary, type TeamRow } from "./teamLogo";

/** The season's league for `userId` (null = signed out); null when there is no league. */
export async function getLeagueOverview(db: Pool, season: number, userId: number | null): Promise<LeagueOverview | null> {
  const { rows: [league] } = await db.query<{
    id: number; name: string; playoff_teams: number; playoff_start_week: number | null;
    toilet_bowl: boolean; toilet_bowl_teams: number; today: string;
  }>(
    `SELECT id::int, name, playoff_teams, playoff_start_week, toilet_bowl, toilet_bowl_teams,
            to_char((now() AT TIME ZONE time_zone)::date, 'YYYY-MM-DD') AS today
     FROM leagues WHERE season = $1 ORDER BY id LIMIT 1`,
    [season],
  );
  if (!league) return null;
  const { today } = league;

  const [{ rows: teams }, { rows: weeks }, { rows: pairs }, { rows: moves }] = await Promise.all([
    db.query<TeamRow & { owner_user_id: number | null }>(
      `SELECT id::int, name, abbreviation, logo_updated_at, owner_user_id::int FROM fantasy_teams WHERE league_id = $1 ORDER BY name`,
      [league.id],
    ),
    db.query<WeekRow>(WEEKS_SQL, [league.id]),
    db.query<BracketRow>(MATCHUP_ROWS_SQL, [league.id]),
    db.query<{ team_id: number; n: number }>(
      `SELECT team_id::int, count(*)::int AS n FROM transactions
       WHERE league_id = $1 AND status = 'completed' AND type IN ('add', 'add_drop', 'waiver_claim')
       GROUP BY team_id`,
      [league.id],
    ),
  ]);

  const summary = (id: number): FantasyTeamSummary => {
    return toTeamSummary(teams.find((x) => x.id === id)!);
  };
  const mine = userId === null ? undefined : teams.find((t) => t.owner_user_id === userId);
  const cfg = configOf({ ...league, team_count: teams.length });
  const start = playoffStart(weeks, league.playoff_start_week);

  // Every week that has started: finished ones and the live one. Standings
  // count only the regular season's.
  const linesByWeek = await startedWeekLines(db, league.id, weeks, today);
  const played = weeks.filter((w) => linesByWeek.has(w.week) && isRegularWeek(w, start));
  const regularLines = new Map(played.map((w) => [w.week, linesByWeek.get(w.week)!]));
  const records = recordsFrom(teams.map((t) => t.id), pairs.filter((p) => p.bracket === null), regularLines);

  const movesById = new Map(moves.map((m) => [m.team_id, m.n]));
  const sorted = standingsOrder(teams.map((t) => ({ ...t, record: records.get(t.id)! })))
    .map((t) => ({ t, record: t.record, pct: winPct(t.record) }));
  const lead = sorted[0]?.record;
  const standings: StandingsRow[] = [];
  sorted.forEach((s, i) => {
    const prev = sorted[i - 1];
    const tied = prev !== undefined && prev.pct === s.pct && prev.record.wins === s.record.wins;
    standings.push({
      ...summary(s.t.id),
      rank: tied ? standings[i - 1].rank : i + 1,
      record: s.record,
      pct: s.pct,
      gamesBack: (lead.wins - s.record.wins + (s.record.losses - lead.losses)) / 2,
      moves: movesById.get(s.t.id) ?? 0,
      isMine: s.t.id === mine?.id,
    });
  });

  const w = weeks.find((x) => today <= x.ends_on) ?? weeks[weeks.length - 1];
  const status = !w || today < w.starts_on ? "upcoming" : today > w.ends_on ? "final" : "live";
  const matchups: OtherMatchup[] = !w ? [] : pairs
    .filter((p) => p.week === w.week)
    .map((p) => {
      // The manager's team reads on the left.
      const flip = mine !== undefined && p.team_b_id === mine.id;
      const [a, b] = flip ? [p.team_b_id!, p.team_a_id] : [p.team_a_id, p.team_b_id];
      const bracket = bracketTag(p, cfg);
      return {
        teamA: summary(a),
        teamB: b === null ? null : summary(b),
        score: b === null ? { wins: 0, losses: 0, ties: 0 } : scoreIn(linesByWeek, w.week, a, b),
        isMine: mine !== undefined && (a === mine.id || b === mine.id),
        ...(bracket && { bracket }),
      };
    })
    .sort((x, y) => Number(y.isMine) - Number(x.isMine));

  const playoffs = buildPlayoffsView({
    cfg, start, weeks, today, rows: pairs, order: sorted.map((s) => s.t.id), team: summary, records,
    mineId: mine?.id ?? null, lines: linesByWeek,
  });

  return {
    season,
    name: league.name,
    teamCount: teams.length,
    playoffTeams: league.playoff_teams,
    standings,
    weeksCounted: played.length,
    includesLiveWeek: status === "live" && played.some((x) => x.week === w.week),
    week: w ? { week: w.week, startsOn: w.starts_on, endsOn: w.ends_on, isPlayoffs: w.is_playoffs, status } : null,
    matchups,
    myTeam: mine ? summary(mine.id) : null,
    toiletBowlTeams: cfg.toiletBowlTeams,
    playoffs,
  };
}

/**
 * The season league's latest completed transactions, newest first, any type
 * (add/drop, waiver claims, trades, commissioner moves). Null when there is no league.
 */
export async function getRecentTransactions(db: Pool, season: number, limit = 25): Promise<RecentTransactions | null> {
  const { rows: [league] } = await db.query<{ id: number; time_zone: string }>(
    `SELECT id::int, time_zone FROM leagues WHERE season = $1 ORDER BY id LIMIT 1`,
    [season],
  );
  if (!league) return null;
  const { rows } = await db.query<{
    id: number; type: LeagueTransaction["type"]; at: string; faab_bid: number | null;
    team_id: number | null; trade_team_id: number | null;
    player_id: number | null; first_name: string | null; last_name: string | null; position: string | null;
    nba_person_id: number | null; team_abbr: string | null; from_team_id: number | null; to_team_id: number | null;
  }>(
    `WITH t AS (
       SELECT id, type, team_id, trade_team_id, faab_bid, coalesce(processed_at, created_at) AS at
       FROM transactions
       -- Claims a waiver run decided show in that run's summary instead.
       WHERE league_id = $1 AND status = 'completed' AND NOT (type = 'waiver_claim' AND waiver_run_id IS NOT NULL)
       ORDER BY coalesce(processed_at, created_at) DESC, id DESC
       LIMIT $2
     )
     SELECT t.id::int, t.type, to_char(t.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
            t.team_id::int, t.trade_team_id::int, t.faab_bid,
            tp.player_id, p.first_name, p.last_name, nullif(p.position, '') AS position, p.nba_person_id,
            nt.abbreviation AS team_abbr, tp.from_team_id::int, tp.to_team_id::int
     FROM t
     LEFT JOIN transaction_players tp ON tp.transaction_id = t.id
     LEFT JOIN players p ON p.id = tp.player_id
     LEFT JOIN teams nt ON nt.id = p.team_id
     ORDER BY t.at DESC, t.id DESC, p.last_name, p.first_name`,
    [league.id, limit],
  );
  const { rows: teams } = await db.query<TeamRow>(
    `SELECT id::int, name, abbreviation, logo_updated_at FROM fantasy_teams WHERE league_id = $1`,
    [league.id],
  );
  const teamById = new Map(teams.map((t) => [t.id, toTeamSummary(t)]));
  const team = (id: number | null) => (id === null ? null : teamById.get(id) ?? null);

  const byId = new Map<number, LeagueTransaction>();
  for (const r of rows) {
    let tx = byId.get(r.id);
    if (!tx) {
      tx = { id: r.id, type: r.type, at: r.at, team: team(r.team_id), tradeTeam: team(r.trade_team_id), moves: [],
        faabBid: r.type === "waiver_claim" ? r.faab_bid : null,
      };
      byId.set(r.id, tx);
    }
    if (r.player_id === null) continue;
    tx.moves.push({
      player: {
        id: r.player_id, firstName: r.first_name ?? "", lastName: r.last_name ?? "", teamAbbr: r.team_abbr,
        position: r.position, nbaPersonId: r.nba_person_id,
      },
      from: team(r.from_team_id),
      to: team(r.to_team_id),
    });
  }
  // Adds, then players changing teams, then drops.
  const rank = (m: TransactionMove) => (m.from === null ? 0 : m.to === null ? 2 : 1);
  for (const tx of byId.values()) tx.moves.sort((a, b) => rank(a) - rank(b));
  return {
    timeZone: league.time_zone,
    transactions: [...byId.values()],
    waiverRuns: await getWaiverRunEntries(db, league.id, team),
  };
}

/**
 * The league's latest waiver runs that decided claims (newest first), each with
 * every claim it decided, won or failed, grouped by player: the whole auction.
 */
async function getWaiverRunEntries(
  db: Pool, leagueId: number, team: (id: number | null) => FantasyTeamSummary | null, limit = 10,
): Promise<WaiverRunEntry[]> {
  const { rows } = await db.query<{
    run_id: number; at: string; claim_id: number; team_id: number; status: string; faab_bid: number | null;
    failure_reason: string | null; is_add: boolean; player_id: number; first_name: string; last_name: string;
    position: string | null; nba_person_id: number | null; team_abbr: string | null;
  }>(
    `WITH r AS (
       SELECT r.id, coalesce(r.finished_at, r.started_at) AS at FROM waiver_runs r
        WHERE r.league_id = $1 AND EXISTS (SELECT 1 FROM transactions t WHERE t.waiver_run_id = r.id)
        ORDER BY coalesce(r.finished_at, r.started_at) DESC, r.id DESC
        LIMIT $2
     )
     SELECT r.id::int AS run_id, to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
            t.id::int AS claim_id, t.team_id::int, t.status, t.faab_bid, t.failure_reason,
            tp.to_team_id IS NOT NULL AS is_add, p.id AS player_id, p.first_name, p.last_name,
            nullif(p.position, '') AS position, p.nba_person_id, nt.abbreviation AS team_abbr
       FROM r
       JOIN transactions t ON t.waiver_run_id = r.id
       JOIN transaction_players tp ON tp.transaction_id = t.id
       JOIN players p ON p.id = tp.player_id
       LEFT JOIN teams nt ON nt.id = p.team_id
      ORDER BY r.at DESC, r.id DESC, t.id`,
    [leagueId, limit],
  );

  type Claim = WaiverRunClaim & { add: PlayerSummary };
  const runs = new Map<number, { at: string; claims: Map<number, Claim> }>();
  for (const r of rows) {
    let run = runs.get(r.run_id);
    if (!run) runs.set(r.run_id, (run = { at: r.at, claims: new Map() }));
    const player: PlayerSummary = {
      id: r.player_id, firstName: r.first_name, lastName: r.last_name, teamAbbr: r.team_abbr,
      position: r.position, nbaPersonId: r.nba_person_id,
    };
    let c = run.claims.get(r.claim_id);
    if (!c) {
      const t = team(r.team_id);
      if (!t) continue;
      c = { team: t, bid: r.faab_bid, won: r.status === "completed", drop: null, reason: r.failure_reason, add: player };
      run.claims.set(r.claim_id, c);
    }
    if (r.is_add) c.add = player;
    else c.drop = player;
  }

  return [...runs].map(([id, run]) => {
    const claims = [...run.claims.values()];
    const byPlayer = new Map<number, { player: PlayerSummary; claims: WaiverRunClaim[] }>();
    for (const { add, ...c } of claims) {
      if (!byPlayer.has(add.id)) byPlayer.set(add.id, { player: add, claims: [] });
      byPlayer.get(add.id)!.claims.push(c);
    }
    const players = [...byPlayer.values()];
    const faab = claims.some((c) => c.bid !== null);
    for (const p of players) {
      p.claims.sort((a, b) => Number(b.won) - Number(a.won) || (b.bid ?? -1) - (a.bid ?? -1) || a.team.name.localeCompare(b.team.name));
      // Losing to the winner is worded for the manager ("ahead of you", resolveClaims);
      // say it for the whole league here.
      const w = p.claims.find((c) => c.won);
      if (!w) continue;
      for (const c of p.claims) {
        if (c.won || !c.reason?.includes(` went to ${w.team.abbreviation}`)) continue;
        const abbr = w.team.abbreviation;
        c.reason = !faab
          ? `${abbr} was ahead in the waiver order.`
          : c.bid === w.bid
            ? `Tied at $${w.bid}; ${abbr} had priority.`
            : `Outbid by ${abbr} at $${w.bid}.`;
      }
    }
    const wonAny = (p: (typeof players)[number]) => Number(p.claims[0]?.won ?? false);
    players.sort((a, b) => wonAny(b) - wonAny(a) || (b.claims[0].bid ?? -1) - (a.claims[0].bid ?? -1)
      || a.player.lastName.localeCompare(b.player.lastName));
    return {
      id, at: run.at,
      faab,
      won: claims.filter((c) => c.won).length,
      failed: claims.filter((c) => !c.won).length,
      players,
    };
  });
}

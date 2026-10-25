// League standings and this week's scoreboard behind the /league page.
//
// Standings are each team's category record (W–L–T) over every week played:
// the finished weeks plus the current one's live score. Each week is scored
// the same way as /matchup (queries/matchups.ts), on read.
import type { Pool } from "pg";
import type { FantasyTeamSummary, LeagueOverview, MatchupScore, OtherMatchup, StandingsRow } from "../types";
import { compareLines, emptyLine, weekLines } from "./matchups";

interface WeekRow {
  week: number;
  starts_on: string;
  ends_on: string;
  is_playoffs: boolean;
}

/** (W + T/2) / categories, rounded to three decimals. */
function winPct(r: MatchupScore): number | null {
  const n = r.wins + r.losses + r.ties;
  return n > 0 ? Math.round(((r.wins + r.ties / 2) / n) * 1000) / 1000 : null;
}

/** The season's league for `userId` (null = signed out); null when there is no league. */
export async function getLeagueOverview(db: Pool, season: number, userId: number | null): Promise<LeagueOverview | null> {
  const { rows: [league] } = await db.query<{ id: number; name: string; playoff_teams: number; today: string }>(
    `SELECT id::int, name, playoff_teams, to_char((now() AT TIME ZONE time_zone)::date, 'YYYY-MM-DD') AS today
     FROM leagues WHERE season = $1 ORDER BY id LIMIT 1`,
    [season],
  );
  if (!league) return null;
  const { today } = league;

  const [{ rows: teams }, { rows: weeks }, { rows: pairs }, { rows: moves }] = await Promise.all([
    db.query<FantasyTeamSummary & { owner_user_id: number | null }>(
      `SELECT id::int, name, abbreviation, owner_user_id::int FROM fantasy_teams WHERE league_id = $1 ORDER BY name`,
      [league.id],
    ),
    db.query<WeekRow>(
      `SELECT week, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on, is_playoffs
       FROM league_weeks WHERE league_id = $1 ORDER BY week`,
      [league.id],
    ),
    db.query<{ week: number; team_a_id: number; team_b_id: number | null }>(
      `SELECT week, team_a_id::int, team_b_id::int FROM matchups WHERE league_id = $1 ORDER BY week, id`,
      [league.id],
    ),
    db.query<{ team_id: number; n: number }>(
      `SELECT team_id::int, count(*)::int AS n FROM transactions
       WHERE league_id = $1 AND status = 'completed' AND type IN ('add', 'add_drop', 'waiver_claim')
       GROUP BY team_id`,
      [league.id],
    ),
  ]);

  const summary = (id: number): FantasyTeamSummary => {
    const t = teams.find((x) => x.id === id)!;
    return { id: t.id, name: t.name, abbreviation: t.abbreviation };
  };
  const mine = userId === null ? undefined : teams.find((t) => t.owner_user_id === userId);

  // Every week that has started: finished ones and the live one.
  const played = weeks.filter((w) => w.starts_on <= today);
  const lines = await Promise.all(
    played.map((w) => weekLines(db, league.id, { startsOn: w.starts_on, endsOn: w.ends_on }, today)),
  );
  const linesByWeek = new Map(played.map((w, i) => [w.week, lines[i]]));
  const scoreOf = (week: number, a: number, b: number) => {
    const l = linesByWeek.get(week);
    return l ? compareLines(l.get(a) ?? emptyLine(), l.get(b) ?? emptyLine()).score : { wins: 0, losses: 0, ties: 0 };
  };

  const records = new Map<number, MatchupScore>(teams.map((t) => [t.id, { wins: 0, losses: 0, ties: 0 }]));
  for (const p of pairs) {
    if (p.team_b_id === null || !linesByWeek.has(p.week)) continue;
    const s = scoreOf(p.week, p.team_a_id, p.team_b_id);
    const a = records.get(p.team_a_id)!;
    const b = records.get(p.team_b_id)!;
    a.wins += s.wins; a.losses += s.losses; a.ties += s.ties;
    b.wins += s.losses; b.losses += s.wins; b.ties += s.ties;
  }

  const movesById = new Map(moves.map((m) => [m.team_id, m.n]));
  const sorted = teams
    .map((t) => ({ t, record: records.get(t.id)!, pct: winPct(records.get(t.id)!) }))
    .sort((x, y) => (y.pct ?? 0) - (x.pct ?? 0) || y.record.wins - x.record.wins || x.t.name.localeCompare(y.t.name));
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
      return {
        teamA: summary(a),
        teamB: b === null ? null : summary(b),
        score: b === null ? { wins: 0, losses: 0, ties: 0 } : scoreOf(w.week, a, b),
        isMine: mine !== undefined && (a === mine.id || b === mine.id),
      };
    })
    .sort((x, y) => Number(y.isMine) - Number(x.isMine));

  return {
    season,
    name: league.name,
    teamCount: teams.length,
    playoffTeams: league.playoff_teams,
    standings,
    weeksCounted: played.length,
    includesLiveWeek: status === "live",
    week: w ? { week: w.week, startsOn: w.starts_on, endsOn: w.ends_on, isPlayoffs: w.is_playoffs, status } : null,
    matchups,
    myTeam: mine ? summary(mine.id) : null,
  };
}

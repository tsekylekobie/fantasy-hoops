// ESPN data client: the same methods as BALLDONTLIE's (src/lib/data's
// DataClient), from ESPN's keyless JSON endpoints. Pages are per request:
// one team's roster or schedule, one date's games, one game's box score.
//   teams                      GET teams
//   players                    GET teams/{id}/roster, the 30 of them
//   games by date              GET scoreboard?dates=YYYYMMDD
//   games by season            GET teams/{id}/schedule?season=&seasontype= (2 regular; 5 play-in
//                              and 3 playoffs once the regular season is nearly over)
//   stats by game              GET summary?event={id}
//   stats by date              the date's scoreboard, then each started game's summary
//   stats by season            each stored game's summary, date by date; the cursor is the
//                              date to resume from (yyyymmdd)
//   injuries                   GET injuries (every team's report in one)
import type { Pool } from "pg";
import type { DataClient, GamesQuery, ListOptions, StatsQuery } from "../data";
import type { Game, Injury, Page, Player, StatLine, Team } from "../data/types";
import { EspnHttp, type EspnHttpOptions } from "./http";
import { espnGameIds, resolveGames, resolvePlayers } from "./ids";
import {
  boxAthletes,
  espnSeasonYear,
  gameKey,
  injuryAthlete,
  isStoredGame,
  ourTeamId,
  rosterAthlete,
  toGame,
  toInjury,
  toPlayer,
  toStatLines,
  toTeam,
  ymd,
  type EspnAthlete,
} from "./map";
import type {
  EspnEvent,
  EspnInjuriesResponse,
  EspnRosterResponse,
  EspnScheduleResponse,
  EspnScoreboardResponse,
  EspnSummaryResponse,
  EspnTeamsResponse,
} from "./raw";

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

const todayEastern = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** Dates from the cursor (yyyymmdd) on. */
const fromCursor = (dates: string[], cursor: number | null | undefined) =>
  cursor ? dates.filter((d) => Number(ymd(d)) >= cursor) : dates;

const nextCursor = (dates: string[], i: number) => (i + 1 < dates.length ? Number(ymd(dates[i + 1])) : null);

export class EspnClient implements DataClient {
  readonly provider = "espn" as const;
  readonly http: EspnHttp;

  constructor(
    private readonly db: Pool,
    opts: EspnHttpOptions = {},
  ) {
    this.http = new EspnHttp(opts);
  }

  get requestCount() {
    return this.http.requestCount;
  }

  async teams(): Promise<Team[]> {
    const body = await this.http.get<EspnTeamsResponse>("teams");
    return body.sports[0].leagues[0].teams.map((t) => toTeam(t.team)).filter((t): t is Team => t !== null);
  }

  /** Everyone on the 30 rosters, one page per team. Players not on a roster aren't listed. */
  async *players(_opts: ListOptions = {}): AsyncGenerator<Page<Player>> {
    const teams = await this.teams();
    for (const t of teams) {
      const body = await this.http.get<EspnRosterResponse>(`teams/${t.espnId}/roster`);
      const athletes = body.athletes.map((a) => ({ a, e: rosterAthlete(a, t.id) }));
      const ids = await resolvePlayers(this.db, athletes.map((x) => x.e));
      yield {
        items: athletes.map(({ a, e }) => toPlayer(e, ids.get(e.espnId)!, { id: a.id, displayName: a.displayName, position: a.position?.abbreviation ?? null, jersey: a.jersey ?? null, team: t.abbreviation })),
        nextCursor: null,
      };
    }
  }

  /** The stored games among `events`, with our ids. */
  private async toGames(events: EspnEvent[], date?: string): Promise<Game[]> {
    const stored = events.filter(isStoredGame);
    const ids = await resolveGames(this.db, stored.map((e) => gameKey(e, date)));
    return stored.map((e) => toGame(e, ids.get(Number(e.id))!, date));
  }

  private async scoreboard(date: string): Promise<EspnScoreboardResponse> {
    return this.http.get<EspnScoreboardResponse>("scoreboard", { dates: ymd(date), limit: 100 });
  }

  async *games(q: GamesQuery): AsyncGenerator<Page<Game>> {
    const keep = (g: Game) =>
      (!q.teamIds?.length || q.teamIds.includes(g.homeTeamId) || q.teamIds.includes(g.visitorTeamId)) &&
      (q.postseason === undefined || g.postseason === q.postseason) &&
      (!q.startDate || g.date >= q.startDate) &&
      (!q.endDate || g.date <= q.endDate);

    if (q.seasons?.length) {
      for (const season of q.seasons) yield* this.seasonGames(season, keep);
      return;
    }
    const dates = fromCursor(q.dates ?? (q.startDate ? datesBetween(q.startDate, q.endDate ?? todayEastern()) : []), q.cursor);
    for (let i = 0; i < dates.length; i++) {
      const body = await this.scoreboard(dates[i]);
      const games = await this.toGames(body.events, dates[i]);
      yield { items: games.filter(keep), nextCursor: nextCursor(dates, i) };
    }
  }

  /** A season's schedule from the 30 teams' schedules; each game comes once. */
  private async *seasonGames(season: number, keep: (g: Game) => boolean): AsyncGenerator<Page<Game>> {
    const teams = await this.teams();
    const seen = new Set<number>();
    let lastRegular = "";
    const fetchType = async function* (this: EspnClient, seasonType: number) {
      for (const t of teams) {
        const body = await this.http.get<EspnScheduleResponse>(`teams/${t.espnId}/schedule`, {
          season: espnSeasonYear(season),
          seasontype: seasonType,
        });
        const events = (body.events ?? []).filter((e) => !seen.has(Number(e.id)));
        for (const e of events) seen.add(Number(e.id));
        const games = await this.toGames(events);
        if (seasonType === 2) for (const g of games) if (g.date > lastRegular) lastRegular = g.date;
        yield { items: games.filter(keep), nextCursor: null };
      }
    };
    yield* fetchType.call(this, 2);
    // Play-in and playoff games exist only once the regular season is about done.
    if (lastRegular && todayEastern() >= addDays(lastRegular, -3)) {
      yield* fetchType.call(this, 5);
      yield* fetchType.call(this, 3);
    }
  }

  /** One game's box score as stat lines (none before tip-off). */
  private async gameStats(espnEventId: number, gameId?: number): Promise<StatLine[]> {
    const body = await this.http.get<EspnSummaryResponse>("summary", { event: espnEventId });
    const comp = body.header.competitions[0];
    if (!comp || !body.boxscore.players?.length) return [];
    if (comp.competitors.some((c) => ourTeamId(c.team) === null)) return [];
    if (gameId === undefined) {
      const event: EspnEvent = { id: body.header.id, date: comp.date, season: body.header.season, competitions: [comp] };
      gameId = (await resolveGames(this.db, [gameKey(event)])).get(espnEventId)!;
    }
    const players = await resolvePlayers(this.db, boxAthletes(body));
    return toStatLines(body, { gameId, players });
  }

  async *stats(q: StatsQuery): AsyncGenerator<Page<StatLine>> {
    const keep = (l: StatLine) =>
      (!q.playerIds?.length || q.playerIds.includes(l.playerId)) &&
      (q.postseason === undefined || l.postseason === q.postseason);

    if (q.gameIds) {
      const espn = await espnGameIds(this.db, q.gameIds);
      for (const id of q.gameIds) {
        const eventId = espn.get(id);
        if (eventId === undefined) continue; // not linked to ESPN (scripts/espn/match-ids.ts)
        yield { items: (await this.gameStats(eventId, id)).filter(keep), nextCursor: null };
      }
      return;
    }

    if (q.dates?.length || (!q.seasons?.length && q.startDate)) {
      const dates = fromCursor(q.dates ?? datesBetween(q.startDate!, q.endDate ?? todayEastern()), q.cursor);
      for (let i = 0; i < dates.length; i++) {
        const body = await this.scoreboard(dates[i]);
        const started = body.events.filter(
          (e) => isStoredGame(e) && (e.competitions[0].status ?? e.status)?.type.state !== "pre",
        );
        const ids = await resolveGames(this.db, started.map((e) => gameKey(e, dates[i])));
        const items: StatLine[] = [];
        for (const e of started) items.push(...(await this.gameStats(Number(e.id), ids.get(Number(e.id)))));
        yield { items: items.filter(keep), nextCursor: nextCursor(dates, i) };
      }
      return;
    }

    // Whole seasons: every stored game that has started, by date (sync the games first).
    for (const season of q.seasons ?? []) {
      const { rows } = await this.db.query<{ date: string; ids: number[]; espn: number[] }>(
        `SELECT to_char(date, 'YYYY-MM-DD') AS date, array_agg(id ORDER BY id) AS ids, array_agg(espn_id ORDER BY id) AS espn
           FROM games
          WHERE season = $1 AND espn_id IS NOT NULL AND NOT postponed
            AND ($2::date IS NULL OR date >= $2::date) AND ($3::date IS NULL OR date <= $3::date)
            AND (coalesce(status_state, 'scheduled') <> 'scheduled' OR datetime <= now())
          GROUP BY date ORDER BY date`,
        [season, q.startDate ?? null, q.endDate ?? null],
      );
      const dates = fromCursor(rows.map((r) => r.date), q.cursor);
      const byDate = new Map(rows.map((r) => [r.date, r]));
      for (let i = 0; i < dates.length; i++) {
        const r = byDate.get(dates[i])!;
        const items: StatLine[] = [];
        for (let j = 0; j < r.ids.length; j++) items.push(...(await this.gameStats(r.espn[j], r.ids[j])));
        yield { items: items.filter(keep), nextCursor: nextCursor(dates, i) };
      }
    }
  }

  async *injuries(_opts: ListOptions = {}): AsyncGenerator<Page<Injury>> {
    const body = await this.http.get<EspnInjuriesResponse>("injuries");
    const entries = body.injuries
      .flatMap((t) => t.injuries)
      .map((i) => ({ i, a: injuryAthlete(i) }))
      .filter((x): x is { i: (typeof x)["i"]; a: EspnAthlete } => x.a !== null);
    const ids = await resolvePlayers(this.db, entries.map((x) => x.a));
    yield { items: entries.map(({ i, a }) => toInjury(i, ids.get(a.espnId)!)), nextCursor: null };
  }
}


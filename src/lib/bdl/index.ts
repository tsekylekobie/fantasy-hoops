// BALLDONTLIE client: the only module that talks to the data provider.
// Callers get provider-neutral types (./types); swapping providers means
// reimplementing this module with the same exports.

import { BdlHttp, type BdlHttpOptions } from "./http";
import type { BdlGame, BdlInjury, BdlNestedGame, BdlNestedPlayer, BdlPlayer, BdlStat, BdlTeam } from "./raw";
import type { Game, Injury, Page, Player, StatLine, Team } from "./types";

export type { Game, Injury, Page, Player, StatLine, Team } from "./types";
export { BdlError } from "./http";

const PER_PAGE = 100; // API maximum

/** Parse the API's minutes string ("MM:SS", "MM", "0", null) to decimal minutes. */
export function parseMinutes(min: string | number | null | undefined): number {
  if (min == null) return 0;
  if (typeof min === "number") return Number.isFinite(min) ? min : 0;
  const s = min.trim();
  if (!s) return 0;
  const [m, sec] = s.split(":");
  const minutes = Number(m);
  const seconds = sec === undefined ? 0 : Number(sec);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return 0;
  return Math.round((minutes + seconds / 60) * 100) / 100;
}

const blankToNull = (s: string | null | undefined) => (s == null || s.trim() === "" ? null : s);

export function toTeam(t: BdlTeam): Team {
  return {
    id: t.id,
    abbreviation: t.abbreviation,
    city: blankToNull(t.city),
    name: blankToNull(t.name),
    fullName: blankToNull(t.full_name),
    conference: blankToNull(t.conference),
    division: blankToNull(t.division),
    isCurrent: t.id >= 1 && t.id <= 30 && !!blankToNull(t.conference),
    raw: t,
  };
}

export function toPlayer(p: BdlPlayer | BdlNestedPlayer): Player {
  const team = "team" in p && p.team ? toTeam(p.team) : null;
  const teamId = "team_id" in p ? (p.team_id ?? null) : (team?.id ?? null);
  return {
    id: p.id,
    firstName: p.first_name,
    lastName: p.last_name,
    position: blankToNull(p.position),
    teamId,
    jerseyNumber: blankToNull(p.jersey_number),
    team,
    raw: p,
  };
}

export function toGame(g: BdlGame | BdlNestedGame): Game {
  const homeTeamId = "home_team" in g ? g.home_team.id : g.home_team_id;
  const visitorTeamId = "visitor_team" in g ? g.visitor_team.id : g.visitor_team_id;
  return {
    id: g.id,
    date: g.date.slice(0, 10),
    season: g.season,
    status: g.status ?? null,
    statusState: g.status_state ?? null,
    period: g.period ?? null,
    time: g.time ?? null,
    postseason: !!g.postseason,
    postponed: !!g.postponed,
    datetime: g.datetime ?? null,
    homeTeamId,
    visitorTeamId,
    homeTeamScore: g.home_team_score ?? null,
    visitorTeamScore: g.visitor_team_score ?? null,
    raw: g,
  };
}

export function toStatLine(s: BdlStat): StatLine {
  const n = (v: number | null | undefined) => v ?? 0;
  const game = toGame(s.game);
  return {
    id: s.id,
    playerId: s.player.id,
    gameId: s.game.id,
    teamId: s.team?.id ?? null,
    season: s.game.season,
    postseason: !!s.game.postseason,
    min: parseMinutes(s.min),
    fgm: n(s.fgm),
    fga: n(s.fga),
    fg3m: n(s.fg3m),
    fg3a: n(s.fg3a),
    ftm: n(s.ftm),
    fta: n(s.fta),
    oreb: n(s.oreb),
    dreb: n(s.dreb),
    reb: n(s.reb),
    ast: n(s.ast),
    stl: n(s.stl),
    blk: n(s.blk),
    turnover: n(s.turnover),
    pf: n(s.pf),
    pts: n(s.pts),
    plusMinus: s.plus_minus ?? null,
    player: toPlayer(s.player),
    team: s.team ? toTeam(s.team) : null,
    game,
    raw: s,
  };
}

export function toInjury(i: BdlInjury): Injury {
  return {
    playerId: i.player.id,
    player: toPlayer(i.player),
    status: i.status,
    returnDate: blankToNull(i.return_date),
    description: blankToNull(i.description),
    raw: i,
  };
}

export interface ListOptions {
  /** Resume from a saved cursor. */
  cursor?: number | null;
}

export interface GamesQuery extends ListOptions {
  seasons?: number[];
  dates?: string[];
  teamIds?: number[];
  postseason?: boolean;
  startDate?: string;
  endDate?: string;
}

export interface StatsQuery extends ListOptions {
  seasons?: number[];
  dates?: string[];
  gameIds?: number[];
  playerIds?: number[];
  postseason?: boolean;
  startDate?: string;
  endDate?: string;
}

export class DataClient {
  readonly http: BdlHttp;

  constructor(opts: BdlHttpOptions = {}) {
    this.http = new BdlHttp(opts);
  }

  /** Requests sent so far (including retries). */
  get requestCount() {
    return this.http.requestCount;
  }

  /** All teams, including defunct franchises (filter on `isCurrent`). */
  async teams(): Promise<Team[]> {
    const body = await this.http.get<{ data: BdlTeam[] }>("/teams");
    return body.data.map(toTeam);
  }

  async *players(opts: ListOptions & { search?: string } = {}): AsyncGenerator<Page<Player>> {
    for await (const p of this.http.pages<BdlPlayer>("/players", {
      per_page: PER_PAGE,
      cursor: opts.cursor,
      search: opts.search,
    })) {
      yield { items: p.data.map(toPlayer), nextCursor: p.nextCursor };
    }
  }

  async *games(q: GamesQuery): AsyncGenerator<Page<Game>> {
    for await (const p of this.http.pages<BdlGame>("/games", {
      per_page: PER_PAGE,
      cursor: q.cursor,
      "seasons[]": q.seasons,
      "dates[]": q.dates,
      "team_ids[]": q.teamIds,
      postseason: q.postseason,
      start_date: q.startDate,
      end_date: q.endDate,
    })) {
      yield { items: p.data.map(toGame), nextCursor: p.nextCursor };
    }
  }

  async *stats(q: StatsQuery): AsyncGenerator<Page<StatLine>> {
    for await (const p of this.http.pages<BdlStat>("/stats", {
      per_page: PER_PAGE,
      cursor: q.cursor,
      "seasons[]": q.seasons,
      "dates[]": q.dates,
      "game_ids[]": q.gameIds,
      "player_ids[]": q.playerIds,
      postseason: q.postseason,
      start_date: q.startDate,
      end_date: q.endDate,
    })) {
      yield { items: p.data.map(toStatLine), nextCursor: p.nextCursor };
    }
  }

  async *injuries(opts: ListOptions = {}): AsyncGenerator<Page<Injury>> {
    for await (const p of this.http.pages<BdlInjury>("/player_injuries", {
      per_page: PER_PAGE,
      cursor: opts.cursor,
    })) {
      yield { items: p.data.map(toInjury), nextCursor: p.nextCursor };
    }
  }
}

/** Convenience: a client configured from env. */
export function createClient(opts: BdlHttpOptions = {}): DataClient {
  return new DataClient(opts);
}

// Provider-neutral data types returned by every data provider (src/lib/data.ts
// picks one: src/lib/espn or src/lib/bdl). Field names match our DB columns
// (db/migrations/) so ingest code can write them directly. `id`s are always
// ours (BALLDONTLIE's, or minted for rows only ESPN has); `espnId` is ESPN's,
// set only by the ESPN provider. `raw` keeps the provider's original object.

export interface Team {
  id: number;
  abbreviation: string;
  city: string | null;
  name: string | null;
  fullName: string | null;
  conference: string | null;
  division: string | null;
  /** True for the 30 current NBA franchises. */
  isCurrent: boolean;
  espnId?: number | null;
  raw: unknown;
}

export interface Player {
  id: number;
  firstName: string;
  lastName: string;
  /** null when the provider sends "" */
  position: string | null;
  /** Provider team id, or null (free agent). May reference a defunct franchise. */
  teamId: number | null;
  jerseyNumber: string | null;
  /** Nested team as sent by the provider, when present. */
  team: Team | null;
  espnId?: number | null;
  raw: unknown;
}

export interface Game {
  id: number;
  /** yyyy-mm-dd */
  date: string;
  /** 2026 = 2026-27 */
  season: number;
  status: string | null;
  statusState: string | null;
  period: number | null;
  time: string | null;
  postseason: boolean;
  postponed: boolean;
  /** ISO timestamp of tip-off, when known. */
  datetime: string | null;
  homeTeamId: number;
  visitorTeamId: number;
  homeTeamScore: number | null;
  visitorTeamScore: number | null;
  espnId?: number | null;
  raw: unknown;
}

export interface StatLine {
  /** The provider's stat-line id; null when it has none (ESPN), and the DB assigns one. */
  id: number | null;
  playerId: number;
  gameId: number;
  teamId: number | null;
  season: number;
  postseason: boolean;
  /** Decimal minutes; 0 for a DNP. */
  min: number;
  fgm: number;
  fga: number;
  fg3m: number;
  fg3a: number;
  ftm: number;
  fta: number;
  oreb: number;
  dreb: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  turnover: number;
  pf: number;
  pts: number;
  plusMinus: number | null;
  /** Referenced entities, so callers can upsert anything missing. */
  player: Player;
  team: Team | null;
  game: Game;
  raw: unknown;
}

export interface Injury {
  playerId: number;
  player: Player;
  status: string;
  /** yyyy-mm-dd or null */
  returnDate: string | null;
  /** The news blurb (ESPN), or BALLDONTLIE's text with the injury in it. */
  description: string | null;
  /** The injury itself ("Right Hip Inflammation") when the provider reports it apart (ESPN). */
  injury?: string | null;
  raw: unknown;
}

export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` to get the next page; null on the last page. */
  nextCursor: number | null;
}

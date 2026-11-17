// The NBA data provider the batch scripts and the worker read from. DATA_PROVIDER
// picks it: "espn" (default; keyless JSON endpoints, src/lib/espn) or "bdl"
// (BALLDONTLIE, src/lib/bdl; needs BALLDONTLIE_API_KEY and a tier with /stats and
// /player_injuries). Both return the provider-neutral types in ./types with our
// ids, so everything downstream (scripts/lib/upsert.ts) is the same either way.
import type { Pool } from "pg";
import { DataClient as BdlClient } from "../bdl";
import { EspnClient } from "../espn/client";
import type { Game, Injury, Page, Player, StatLine, Team } from "./types";

export type { Game, Injury, Page, Player, StatLine, Team } from "./types";

export type ProviderName = "espn" | "bdl";

export interface ListOptions {
  /** Resume from a saved cursor (the value a page's nextCursor gave). */
  cursor?: number | null;
}

export interface GamesQuery extends ListOptions {
  seasons?: number[];
  /** yyyy-mm-dd */
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

/**
 * What every provider implements. Lists are async generators of pages; a page's
 * nextCursor can be saved and passed back as `cursor` to resume (BALLDONTLIE: its
 * API cursor; ESPN: the next date as yyyymmdd for date-ordered lists).
 */
export interface DataClient {
  readonly provider: ProviderName;
  /** HTTP requests sent so far (including retries). */
  readonly requestCount: number;
  /** All teams the provider has (filter on `isCurrent`). */
  teams(): Promise<Team[]>;
  players(opts?: ListOptions): AsyncGenerator<Page<Player>>;
  games(q: GamesQuery): AsyncGenerator<Page<Game>>;
  stats(q: StatsQuery): AsyncGenerator<Page<StatLine>>;
  /** The whole current injury report. */
  injuries(opts?: ListOptions): AsyncGenerator<Page<Injury>>;
}

export function providerName(env = process.env.DATA_PROVIDER): ProviderName {
  const p = (env ?? "espn").trim().toLowerCase() || "espn";
  if (p !== "espn" && p !== "bdl") throw new Error(`DATA_PROVIDER must be "espn" or "bdl", not "${env}"`);
  return p;
}

/**
 * The configured provider. ESPN needs the database: its ids are mapped to ours
 * (players.espn_id etc.), and players and games new to us get ids minted there.
 */
export function createClient(db: Pool, provider: ProviderName = providerName()): DataClient {
  return provider === "bdl" ? new BdlClient() : new EspnClient(db);
}

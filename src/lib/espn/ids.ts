// ESPN ids -> ours. Our ids stay BALLDONTLIE's (league history, rosters and
// watchlists key on them); teams/players/games.espn_id links them to ESPN's
// (migration 0024, filled for existing rows by scripts/espn/match-ids.ts).
// A player or game ESPN has and we don't is inserted here as a bare row with a
// new id (players_new_id_seq / games_new_id_seq, from 2 billion up), and the
// sync fills in the rest; inserting at once means two passes can't mint two
// ids for the same ESPN id.
import type { Pool, PoolClient } from "pg";
import type { EspnAthlete, EspnGameKey } from "./map";

type Db = Pool | PoolClient;

const linkChecked = new WeakSet<object>();

/**
 * Refuses to mint ids while the database has BALLDONTLIE players none of which
 * is linked to ESPN: every player would come back as a duplicate. An empty
 * database (a fresh dev setup) is fine.
 */
export async function assertLinked(db: Db): Promise<void> {
  if (linkChecked.has(db)) return;
  const { rows: [r] } = await db.query<{ any: boolean; linked: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM players) AS any, EXISTS (SELECT 1 FROM players WHERE espn_id IS NOT NULL) AS linked`,
  );
  if (r.any && !r.linked) {
    throw new Error(
      "No player is linked to ESPN yet (players.espn_id). Run `npm run espn:match-ids -- --apply` " +
        "before syncing from ESPN, or every player would be added again under a new id.",
    );
  }
  linkChecked.add(db);
}

/** Our player id for each ESPN athlete id; new ones are inserted. */
export async function resolvePlayers(db: Db, athletes: EspnAthlete[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const espnIds = [...new Set(athletes.map((a) => a.espnId))];
  if (!espnIds.length) return out;
  const select = async () => {
    const { rows } = await db.query<{ id: number; espn_id: number }>(
      `SELECT id, espn_id FROM players WHERE espn_id = ANY($1::int[])`,
      [espnIds],
    );
    for (const r of rows) out.set(r.espn_id, r.id);
  };
  await select();
  const missing = [...new Map(athletes.filter((a) => !out.has(a.espnId)).map((a) => [a.espnId, a])).values()];
  if (!missing.length) return out;
  await assertLinked(db);
  await db.query(
    `INSERT INTO players (id, first_name, last_name, position, team_id, jersey_number, espn_id)
     SELECT nextval('players_new_id_seq'), r.first_name, r.last_name, r.position,
            (SELECT t.id FROM teams t WHERE t.id = r.team_id), r.jersey_number, r.espn_id
       FROM jsonb_to_recordset($1::jsonb) AS r(espn_id int, first_name text, last_name text, position text,
            team_id int, jersey_number text)
     ON CONFLICT (espn_id) DO NOTHING`,
    [JSON.stringify(missing.map((a) => ({
      espn_id: a.espnId, first_name: a.firstName, last_name: a.lastName, position: a.position,
      team_id: a.teamId, jersey_number: a.jerseyNumber,
    })))],
  );
  await select();
  return out;
}

/**
 * Our game id for each ESPN event id. A game we have without an ESPN id is
 * linked when its date and teams match (a BALLDONTLIE game not matched yet);
 * anything else is inserted.
 */
export async function resolveGames(db: Db, keys: EspnGameKey[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const espnIds = [...new Set(keys.map((k) => k.espnId))];
  if (!espnIds.length) return out;
  const select = async () => {
    const { rows } = await db.query<{ id: number; espn_id: number }>(
      `SELECT id, espn_id FROM games WHERE espn_id = ANY($1::int[])`,
      [espnIds],
    );
    for (const r of rows) out.set(r.espn_id, r.id);
  };
  await select();
  const missing = [...new Map(keys.filter((k) => !out.has(k.espnId)).map((k) => [k.espnId, k])).values()];
  if (!missing.length) return out;
  const json = JSON.stringify(missing.map((k) => ({
    espn_id: k.espnId, date: k.date, season: k.season, home_team_id: k.homeTeamId, visitor_team_id: k.visitorTeamId,
  })));
  const recordset = `jsonb_to_recordset($1::jsonb) AS r(espn_id int, date date, season int, home_team_id int, visitor_team_id int)`;
  // Link: the one unlinked game with the same date and teams.
  await db.query(
    `UPDATE games g SET espn_id = r.espn_id
       FROM ${recordset}
      WHERE g.espn_id IS NULL AND g.date = r.date AND g.home_team_id = r.home_team_id
        AND g.visitor_team_id = r.visitor_team_id
        AND (SELECT count(*) FROM games x WHERE x.espn_id IS NULL AND x.date = r.date
               AND x.home_team_id = r.home_team_id AND x.visitor_team_id = r.visitor_team_id) = 1`,
    [json],
  );
  await select();
  const left = missing.filter((k) => !out.has(k.espnId));
  if (!left.length) return out;
  await db.query(
    `INSERT INTO games (id, date, season, home_team_id, visitor_team_id, espn_id)
     SELECT nextval('games_new_id_seq'), r.date, r.season,
            (SELECT t.id FROM teams t WHERE t.id = r.home_team_id),
            (SELECT t.id FROM teams t WHERE t.id = r.visitor_team_id), r.espn_id
       FROM ${recordset}
      WHERE r.espn_id = ANY($2::int[])
     ON CONFLICT (espn_id) DO NOTHING`,
    [json, left.map((k) => k.espnId)],
  );
  await select();
  return out;
}

/** ESPN event ids of our games (those linked). */
export async function espnGameIds(db: Db, gameIds: number[]): Promise<Map<number, number>> {
  const { rows } = await db.query<{ id: number; espn_id: number }>(
    `SELECT id, espn_id FROM games WHERE id = ANY($1::int[]) AND espn_id IS NOT NULL`,
    [gameIds],
  );
  return new Map(rows.map((r) => [r.id, r.espn_id]));
}

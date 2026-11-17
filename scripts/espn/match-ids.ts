// Links the teams, players and games we already have (BALLDONTLIE's ids) to
// ESPN's: fills teams/players/games.espn_id (migration 0024). Run it once before
// switching DATA_PROVIDER to espn; the ESPN client refuses to add players while
// none is linked, since every player would come back under a new id.
//
//   npm run espn:match-ids                      # dry run: what would be linked, and what wasn't
//   npm run espn:match-ids -- --apply           # write it
//   npm run espn:match-ids -- --seasons 2026,2025 --box-scores-since 2026-10-20
//   npm run espn:match-ids -- --link 17896067=4433188 --apply   # one by hand (our id = ESPN id)
//
// Teams by abbreviation. Players on the 30 ESPN rosters and the injury report by name and team, then
// name alone (src/lib/yahoo/parse.ts matchPlayer: suffixes and accents ignored,
// nicknames by last name + first initial on the same team); ambiguous and
// unmatched ones are listed. --box-scores-since also reads every linked game's
// box score from that date (one request a game) to match players no longer on
// a roster by the team they played for. Games by date and home/away teams, from
// each team's ESPN schedule for --seasons (default the current one).
// Anything already linked is left alone; rerunning is safe.
import "dotenv/config";
import { Pool, type PoolClient } from "pg";
import { EspnHttp } from "../../src/lib/espn/http";
import {
  boxAthletes,
  espnSeasonYear,
  gameKey,
  injuryAthlete,
  isStoredGame,
  nbaAbbr,
  rosterAthlete,
  toTeam,
  type EspnAthlete,
  type EspnGameKey,
} from "../../src/lib/espn/map";
import type {
  EspnRosterResponse,
  EspnScheduleResponse,
  EspnInjuriesResponse,
  EspnSummaryResponse,
  EspnTeamsResponse,
} from "../../src/lib/espn/raw";
import { CURRENT_SEASON } from "../../src/lib/types";
import { matchPlayer, type OurPlayer } from "../../src/lib/yahoo/parse";

interface Args {
  apply: boolean;
  seasons: number[];
  boxScoresSince: string | null;
  links: [number, number][];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, seasons: [CURRENT_SEASON], boxScoresSince: null, links: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = a.includes("=") && a.startsWith("--") && !a.startsWith("--link") ? a.split("=")[1] : argv[++i];
      if (!v) throw new Error(`Missing value for ${a}`);
      return v;
    };
    if (a === "--apply") args.apply = true;
    else if (a.startsWith("--seasons")) args.seasons = val().split(",").map((s) => Number(s.trim()));
    else if (a.startsWith("--box-scores-since")) args.boxScoresSince = val();
    else if (a === "--link") {
      const m = /^(\d+)=(\d+)$/.exec(argv[++i] ?? "");
      if (!m) throw new Error("--link takes ourId=espnId");
      args.links.push([Number(m[1]), Number(m[2])]);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (args.seasons.some((s) => !Number.isInteger(s))) throw new Error("--seasons takes years, e.g. 2026,2025");
  if (args.boxScoresSince && !/^\d{4}-\d{2}-\d{2}$/.test(args.boxScoresSince)) throw new Error("--box-scores-since takes yyyy-mm-dd");
  return args;
}

const http = new EspnHttp();
const fullName = (a: { firstName: string; lastName: string }) => `${a.firstName} ${a.lastName}`.trim();

async function linkTeams(db: PoolClient): Promise<{ espnToAbbr: Map<number, string>; linked: number }> {
  const body = await http.get<EspnTeamsResponse>("teams");
  const espnToAbbr = new Map<number, string>();
  let linked = 0;
  for (const { team } of body.sports[0].leagues[0].teams) {
    const t = toTeam(team);
    const abbr = nbaAbbr(team.abbreviation);
    espnToAbbr.set(Number(team.id), abbr);
    const res = await db.query(
      `UPDATE teams SET espn_id = $1 WHERE abbreviation = $2 AND espn_id IS DISTINCT FROM $1`,
      [Number(team.id), abbr],
    );
    linked += res.rowCount ?? 0;
    if (!t) console.log(`  team ${team.abbreviation} (${team.id}): not one of the 30`);
  }
  const { rows } = await db.query<{ abbreviation: string }>(`SELECT abbreviation FROM teams WHERE espn_id IS NULL ORDER BY id`);
  if (rows.length) console.log(`  teams without an ESPN id: ${rows.map((r) => r.abbreviation).join(", ")}`);
  return { espnToAbbr, linked };
}

interface Candidate extends EspnAthlete {
  /** NBA abbreviation of the team he's listed with. */
  team: string | null;
  source: string;
}

async function rosterCandidates(espnToAbbr: Map<number, string>): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const [espnTeamId, abbr] of espnToAbbr) {
    const body = await http.get<EspnRosterResponse>(`teams/${espnTeamId}/roster`);
    for (const a of body.athletes) out.push({ ...rosterAthlete(a, null), team: abbr, source: `${abbr} roster` });
  }
  return out;
}

/** Players on the injury report (some are on no roster: two-way, suspended, released). */
async function injuryCandidates(espnToAbbr: Map<number, string>): Promise<Candidate[]> {
  const body = await http.get<EspnInjuriesResponse>("injuries");
  const out: Candidate[] = [];
  for (const i of body.injuries.flatMap((t) => t.injuries)) {
    const a = injuryAthlete(i);
    const team = i.athlete.team ? (espnToAbbr.get(Number(i.athlete.team.id)) ?? nbaAbbr(i.athlete.team.abbreviation)) : null;
    if (a) out.push({ ...a, team, source: `${team ?? "no team"} injury report` });
  }
  return out;
}

async function boxScoreCandidates(db: PoolClient, since: string, seasons: number[]): Promise<Candidate[]> {
  const { rows } = await db.query<{ espn_id: number; date: string }>(
    `SELECT espn_id, to_char(date, 'YYYY-MM-DD') AS date FROM games
      WHERE espn_id IS NOT NULL AND season = ANY($1::int[]) AND date >= $2::date AND date <= now()::date
        AND coalesce(status_state, '') = 'final'
      ORDER BY date, id`,
    [seasons, since],
  );
  console.log(`  reading ${rows.length} box scores since ${since}...`);
  const out: Candidate[] = [];
  for (const g of rows) {
    const body = await http.get<EspnSummaryResponse>("summary", { event: g.espn_id });
    for (const t of body.boxscore.players ?? []) {
      const abbr = nbaAbbr(t.team.abbreviation);
      for (const a of boxAthletes({ ...body, boxscore: { players: [t] } })) {
        out.push({ ...a, team: abbr, source: `${abbr} box score ${g.date}` });
      }
    }
  }
  return out;
}

async function linkPlayers(db: PoolClient, candidates: Candidate[], args: Args) {
  const links = args.links;
  for (const [ourId, espnId] of links) {
    await db.query(`UPDATE players SET espn_id = NULL WHERE espn_id = $1 AND id <> $2`, [espnId, ourId]);
    const res = await db.query(`UPDATE players SET espn_id = $2 WHERE id = $1`, [ourId, espnId]);
    console.log(`  --link ${ourId}=${espnId}: ${res.rowCount ? "set" : "no such player"}`);
  }
  const { rows } = await db.query<{ id: number; first_name: string; last_name: string; team: string | null; espn_id: number | null }>(
    `SELECT p.id, p.first_name, p.last_name, t.abbreviation AS team, p.espn_id
       FROM players p LEFT JOIN teams t ON t.id = p.team_id`,
  );
  const linkedEspn = new Set(rows.filter((r) => r.espn_id !== null).map((r) => r.espn_id));
  const unlinked: OurPlayer[] = rows
    .filter((r) => r.espn_id === null)
    .map((r) => ({ id: r.id, firstName: r.first_name, lastName: r.last_name, team: r.team }));
  const byId = new Map(unlinked.map((p) => [p.id, p]));

  // One candidate per ESPN id: the first source (rosters come first, then box scores, newest team last).
  const unique = new Map<number, Candidate>();
  for (const c of candidates) if (!linkedEspn.has(c.espnId) && !unique.has(c.espnId)) unique.set(c.espnId, c);

  const proposals = new Map<number, Candidate[]>(); // our id -> ESPN candidates
  const unmatched: Candidate[] = [];
  for (const c of unique.values()) {
    const ourId = matchPlayer(
      { key: String(c.espnId), first: c.firstName, last: c.lastName, full: fullName(c), team: c.team ?? "", eligiblePositions: [] },
      unlinked,
    );
    if (ourId === null) unmatched.push(c);
    else proposals.set(ourId, [...(proposals.get(ourId) ?? []), c]);
  }
  let linked = 0;
  const ambiguous: string[] = [];
  for (const [ourId, cs] of proposals) {
    const p = byId.get(ourId)!;
    if (cs.length > 1) {
      ambiguous.push(`${fullName(p)} (${ourId}, ${p.team ?? "no team"}) <- ${cs.map((c) => `${fullName(c)} ${c.espnId} (${c.source})`).join(" | ")}`);
      continue;
    }
    await db.query(`UPDATE players SET espn_id = $2 WHERE id = $1 AND espn_id IS NULL`, [ourId, cs[0].espnId]);
    linked++;
  }
  const notMatched = unmatched;
  console.log(`players: ${linked} linked now, ${linkedEspn.size} were already`);
  if (ambiguous.length) {
    console.log(`  ${ambiguous.length} ambiguous (several ESPN players fit one of ours; link by hand with --link ourId=espnId):`);
    for (const a of ambiguous) console.log(`    ${a}`);
  }
  if (notMatched.length) {
    console.log(`  ${notMatched.length} ESPN players with no match here (they'll be added under new ids):`);
    for (const c of notMatched.sort((a, b) => (a.team ?? "").localeCompare(b.team ?? "") || a.lastName.localeCompare(b.lastName))) {
      console.log(`    ${fullName(c)} ${c.espnId} (${c.source})`);
    }
  }
  // Ours left unlinked that matter: on a team, or with a stat line in the last year.
  const { rows: left } = await db.query<{ id: number; name: string; team: string | null }>(
    `SELECT p.id, p.first_name || ' ' || p.last_name AS name, t.abbreviation AS team
       FROM players p LEFT JOIN teams t ON t.id = p.team_id
      WHERE p.espn_id IS NULL
        AND (p.team_id IS NOT NULL OR EXISTS (
              SELECT 1 FROM player_game_stats s JOIN games g ON g.id = s.game_id
               WHERE s.player_id = p.id AND s.min > 0 AND g.date > now() - interval '1 year'))
      ORDER BY t.abbreviation NULLS LAST, p.last_name`,
  );
  if (left.length) {
    console.log(`  ${left.length} of our players on a team or with a game in the last year are still unlinked` +
      `${args.boxScoresSince ? "" : " (--box-scores-since finds players no longer on a roster)"}:`);
    for (const p of left.slice(0, 60)) console.log(`    ${p.name} (${p.id}, ${p.team ?? "no team"})`);
    if (left.length > 60) console.log(`    ... and ${left.length - 60} more`);
  }
}

async function linkGames(db: PoolClient, espnToAbbr: Map<number, string>, seasons: number[]) {
  for (const season of seasons) {
    const events = new Map<number, EspnGameKey>();
    for (const seasonType of [2, 5, 3]) {
      for (const espnTeamId of espnToAbbr.keys()) {
        const body = await http.get<EspnScheduleResponse>(`teams/${espnTeamId}/schedule`, {
          season: espnSeasonYear(season),
          seasontype: seasonType,
        });
        for (const e of body.events ?? []) if (isStoredGame(e)) events.set(Number(e.id), gameKey(e));
      }
    }
    let linked = 0;
    let already = 0;
    const missing: EspnGameKey[] = [];
    for (const k of events.values()) {
      const { rows } = await db.query<{ id: number; espn_id: number | null }>(
        `SELECT id, espn_id FROM games WHERE date = $1 AND home_team_id = $2 AND visitor_team_id = $3`,
        [k.date, k.homeTeamId, k.visitorTeamId],
      );
      if (rows.some((r) => r.espn_id === k.espnId)) already++;
      else if (rows.length === 1 && rows[0].espn_id === null) {
        await db.query(`UPDATE games SET espn_id = $2 WHERE id = $1`, [rows[0].id, k.espnId]);
        linked++;
      } else missing.push(k);
    }
    const { rows: left } = await db.query<{ id: number; date: string; matchup: string }>(
      `SELECT g.id, to_char(g.date, 'YYYY-MM-DD') AS date, vt.abbreviation || '@' || ht.abbreviation AS matchup
         FROM games g JOIN teams ht ON ht.id = g.home_team_id JOIN teams vt ON vt.id = g.visitor_team_id
        WHERE g.season = $1 AND g.espn_id IS NULL ORDER BY g.date, g.id`,
      [season],
    );
    console.log(`games ${season}: ${events.size} on ESPN, ${linked} linked now, ${already} were already`);
    if (missing.length) console.log(`  ${missing.length} ESPN games with no match here (added under new ids on the next sync)`);
    for (const k of missing.slice(0, 20)) console.log(`    ${k.date} ${k.visitorTeamId}@${k.homeTeamId} (ESPN ${k.espnId})`);
    if (left.length) {
      console.log(`  ${left.length} of our games still without an ESPN id:`);
      for (const g of left.slice(0, 20)) console.log(`    ${g.date} ${g.matchup} (${g.id})`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { espnToAbbr, linked } = await linkTeams(db);
    console.log(`teams: ${linked} linked`);
    await linkGames(db, espnToAbbr, args.seasons);
    const candidates = [...(await rosterCandidates(espnToAbbr)), ...(await injuryCandidates(espnToAbbr))];
    if (args.boxScoresSince) candidates.push(...(await boxScoreCandidates(db, args.boxScoresSince, args.seasons)));
    await linkPlayers(db, candidates, args);
    if (args.apply) {
      await db.query("COMMIT");
      console.log(`applied (${http.requestCount} ESPN requests)`);
    } else {
      await db.query("ROLLBACK");
      console.log(`dry run, nothing written (${http.requestCount} ESPN requests); add --apply to write it`);
    }
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

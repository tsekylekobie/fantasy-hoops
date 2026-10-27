// Replaces this season's league with a Yahoo league as it stood when
// scripts/yahoo/export.ts saved the snapshot folder. A dry run by default:
// everything runs in one transaction that is rolled back, and the report says
// what would change. --apply commits it.
//   npm run yahoo:import -- yahoo-export/12345              # dry run
//   npm run yahoo:import -- yahoo-export/12345 --apply      # first import
//   npm run yahoo:import -- yahoo-export/12345 --apply --replace   # over an existing league
//
// What carries over: teams, the schedule (Yahoo's matchup weeks and
// pairings), every finished week's result exactly as Yahoo scored it
// (week_results), each team's lineup on every day so far, today's rosters,
// waiver order, FAAB balances, players on waivers, the season's transactions,
// and the settings Yahoo has that we do too (src/lib/yahoo/parse.ts parseLeague).
// What doesn't: pending trades and waiver claims (managers resubmit them),
// lineups set ahead for future days, and a playoff bracket in progress
// (import before the playoffs start).
//
// Read from the folder besides raw/:
//   members.csv            each team's manager email(s) and the commissioner; see league_members
//   league-settings.json   optional: settings to use instead of Yahoo's or our defaults, in the
//                          /league/settings shape (LeagueSettings in src/lib/types.ts), e.g.
//                          {"timeZone": "America/Los_Angeles", "gameLimits": {"total": 40, "slots": {}}}
//   player-overrides.csv   Yahoo players matched by hand (yahoo_player_key -> player_id). The import
//                          adds a row with a blank player_id for each player it couldn't match.
//
// Users and their sign-ins are kept: managers who have signed in before are
// linked to their teams right away, everyone else on first sign-in
// (src/lib/auth/members.ts).
import "dotenv/config";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { linkMemberships } from "../../src/lib/auth/members";
import { eligibleSlots, ilEligibility, isStarting, rosterProblems, type IlRules } from "../../src/lib/lineup/rules";
import { getInjuries } from "../../src/lib/queries/injuries";
import { getLeagueSettings, parseSettings } from "../../src/lib/queries/settings";
import { CURRENT_SEASON, TEAM_ABBREVIATION, TEAM_NAME_LENGTH, type LineupSlot } from "../../src/lib/types";
import * as Y from "../../src/lib/yahoo/parse";

const dir = process.argv.slice(2).find((a) => !a.startsWith("--"));
const APPLY = process.argv.includes("--apply");
const REPLACE = process.argv.includes("--replace");
const STALE_OK = process.argv.includes("--stale-ok");

const read = (path: string): unknown => JSON.parse(readFileSync(join(dir!, path), "utf8"));
const has = (path: string) => existsSync(join(dir!, path));
/** Every page in a raw/ subfolder, in file order. */
const pages = (folder: string): unknown[] =>
  has(folder) ? readdirSync(join(dir!, folder)).filter((f) => f.endsWith(".json")).sort().map((f) => read(join(folder, f))) : [];

const errors: string[] = [];
const warnings: string[] = [];
const notes: string[] = [];

interface Snapshot {
  meta: { leagueKey: string; exportedAt: string; today: string };
  league: Y.YahooLeague;
  teams: Y.YahooTeam[];
  weeks: Y.YahooWeek[];
  matchups: Y.YahooMatchup[];
  /** date -> team key -> that day's roster. */
  rosters: Map<string, Map<string, Y.YahooRosterEntry[]>>;
  transactions: Y.YahooTransaction[];
  waivers: { player: Y.YahooPlayer; clearsOn: string | null }[];
}

function loadSnapshot(): Snapshot {
  const meta = read("meta.json") as Snapshot["meta"];
  const league = Y.parseLeague(read("raw/league-settings.json"));
  const rosters = new Map<string, Map<string, Y.YahooRosterEntry[]>>();
  for (const date of has("raw/rosters") ? readdirSync(join(dir!, "raw/rosters")).sort() : []) {
    const byTeam = new Map<string, Y.YahooRosterEntry[]>();
    for (const f of readdirSync(join(dir!, "raw/rosters", date)).filter((f) => f.endsWith(".json"))) {
      byTeam.set(f.replace(/\.json$/, ""), Y.parseRoster(read(join("raw/rosters", date, f))));
    }
    rosters.set(date, byTeam);
  }
  const seen = new Set<string>();
  return {
    meta,
    league,
    teams: Y.parseTeams(read("raw/teams.json")),
    weeks: Y.parseGameWeeks(read("raw/game-weeks.json"))
      .filter((w) => w.week >= league.startWeek && w.week <= league.endWeek)
      .sort((a, b) => a.week - b.week),
    matchups: pages("raw/scoreboard").flatMap(Y.parseScoreboard),
    rosters,
    transactions: pages("raw/transactions").flatMap(Y.parseTransactions)
      .filter((t) => !seen.has(t.key) && seen.add(t.key))
      .sort((a, b) => a.timestamp - b.timestamp),
    waivers: pages("raw/waivers").flatMap(Y.parseWaivers),
  };
}

/** Yahoo player key -> our player id, from the overrides file and then by name. Rewrites the overrides file with what's still unmatched. */
async function matchPlayers(db: PoolClient, snap: Snapshot): Promise<Map<string, number>> {
  const all = new Map<string, { player: Y.YahooPlayer; where: Set<string> }>();
  const note = (p: Y.YahooPlayer, where: string) => {
    const e = all.get(p.key) ?? { player: p, where: new Set<string>() };
    e.where.add(where);
    all.set(p.key, e);
  };
  for (const [date, byTeam] of snap.rosters) {
    for (const entries of byTeam.values()) for (const e of entries) note(e.player, date === snap.meta.today ? "roster" : "past lineups");
  }
  for (const t of snap.transactions) for (const p of t.players) note(p.player, "transactions");
  for (const w of snap.waivers) note(w.player, "waivers");

  const OVERRIDES = "player-overrides.csv";
  const overrides = has(OVERRIDES) ? Y.parseCsv(readFileSync(join(dir!, OVERRIDES), "utf8")) : [];
  const byHand = new Map(overrides.filter((r) => /^\d+$/.test(r.player_id)).map((r) => [r.yahoo_player_key, Number(r.player_id)]));

  const { rows } = await db.query<{ id: number; first_name: string; last_name: string; abbr: string | null }>(
    `SELECT p.id, p.first_name, p.last_name, t.abbreviation AS abbr FROM players p LEFT JOIN teams t ON t.id = p.team_id`,
  );
  const ours: Y.OurPlayer[] = rows.map((r) => ({ id: r.id, firstName: r.first_name, lastName: r.last_name, team: r.abbr }));
  const known = new Set(ours.map((p) => p.id));

  const out = new Map<string, number>();
  const unmatched: Record<string, string>[] = [];
  for (const [key, { player, where }] of all) {
    const id = byHand.get(key) ?? Y.matchPlayer(player, ours);
    if (id !== null && known.has(id)) out.set(key, id);
    else {
      if (id !== null) warnings.push(`player-overrides.csv: ${key} -> ${id}, but there's no player ${id}.`);
      unmatched.push({ yahoo_player_key: key, name: player.full, team: player.team, positions: player.eligiblePositions.join("/"), where: [...where].join("; "), player_id: "" });
      const msg = `No match for ${player.full} (${player.team || "FA"}, ${key}) in ${[...where].join(", ")}.`;
      if (where.has("roster")) errors.push(`${msg} He's on a roster today: add his player id to ${OVERRIDES}.`);
      else warnings.push(`${msg} Skipped there.`);
    }
  }
  // Keep the hand-made rows, and list what's still missing for you to fill in.
  const header = ["yahoo_player_key", "name", "team", "positions", "where", "player_id"];
  const kept = overrides.filter((r) => /^\d+$/.test(r.player_id));
  if (unmatched.length > 0 || has(OVERRIDES)) writeFileSync(join(dir!, OVERRIDES), Y.toCsv(header, [...kept, ...unmatched]));
  notes.push(`Players: ${out.size} matched (${byHand.size} by hand), ${unmatched.length} unmatched.`);
  return out;
}

const YES = new Set(["yes", "y", "true", "1", "x"]);

async function run(db: PoolClient, snap: Snapshot) {
  const { league: yl, meta } = snap;
  if (yl.season !== CURRENT_SEASON) errors.push(`The Yahoo league is season ${yl.season}; this app is on ${CURRENT_SEASON}.`);
  const wanted = Object.values(Y.YAHOO_STAT_IDS).sort();
  if (JSON.stringify([...yl.statIds].sort()) !== JSON.stringify(wanted)) {
    errors.push(`The Yahoo league scores stat ids ${yl.statIds.join(", ")}; this app scores the nine categories (${wanted.join(", ")}).`);
  }
  if (snap.teams.length < 2) errors.push("The snapshot has no teams.");
  if (snap.weeks.length === 0) errors.push("The snapshot has no matchup weeks.");
  const todayRosters = snap.rosters.get(meta.today);
  if (!todayRosters || todayRosters.size !== snap.teams.length) errors.push(`The snapshot has no rosters for ${meta.today} for every team; export again.`);

  const playerIds = await matchPlayers(db, snap);
  const pid = (p: Y.YahooPlayer) => playerIds.get(p.key) ?? null;

  // --- The league ---
  const { rows: existing } = await db.query<{ id: number; name: string; teams: number; imported_at: Date | null; owned: number }>(
    `SELECT l.id::int, l.name, l.imported_at,
            (SELECT count(*)::int FROM fantasy_teams ft WHERE ft.league_id = l.id) AS teams,
            (SELECT count(*)::int FROM fantasy_teams ft WHERE ft.league_id = l.id AND ft.owner_user_id IS NOT NULL) AS owned
       FROM leagues l WHERE l.season = $1`,
    [CURRENT_SEASON],
  );
  for (const l of existing) {
    const what = `"${l.name}" (${l.teams} teams, ${l.owned} with managers${l.imported_at ? `, imported ${l.imported_at.toISOString()}` : ""})`;
    if (REPLACE) notes.push(`Replaces the existing league ${what}: everything in it is deleted.`);
    else errors.push(`There's already a ${CURRENT_SEASON} league, ${what}. Add --replace to delete it and import over it.`);
  }
  await db.query(`DELETE FROM leagues WHERE season = $1`, [CURRENT_SEASON]);

  // Our week numbers start at 1.
  const ourWeek = (yahooWeek: number) => yahooWeek - yl.startWeek + 1;
  const playoffStart = yl.playoffStartWeek === null ? null : ourWeek(yl.playoffStartWeek);
  const { rows: [{ id: leagueId }] } = await db.query<{ id: number }>(
    `INSERT INTO leagues (name, season, max_teams, roster_slots, yahoo_league_key, imported_at)
     VALUES ($1, $2, $3, $4, $5, now()) RETURNING id::int`,
    [yl.name, CURRENT_SEASON, snap.teams.length, JSON.stringify(yl.rosterSlots), yl.key],
  );
  for (const w of snap.weeks) {
    await db.query(
      `INSERT INTO league_weeks (league_id, week, starts_on, ends_on, is_playoffs) VALUES ($1, $2, $3, $4, $5)`,
      [leagueId, ourWeek(w.week), w.start, w.end, playoffStart !== null && ourWeek(w.week) >= playoffStart],
    );
  }

  // --- Teams and members ---
  const members = has("members.csv") ? Y.parseCsv(readFileSync(join(dir!, "members.csv"), "utf8")) : [];
  if (!has("members.csv")) errors.push("members.csv is missing (yahoo:export writes one to fill in).");
  const teamIds = new Map<string, number>();
  const taken = new Set<string>();
  for (const t of snap.teams) {
    const m = members.filter((r) => r.yahoo_team_key === t.key);
    let name = t.name.trim().slice(0, TEAM_NAME_LENGTH.max);
    if (name.length < TEAM_NAME_LENGTH.min) name = `Team ${t.key.split(".t.")[1] ?? ""}`.trim();
    if (name !== t.name) warnings.push(`Team "${t.name}" is named "${name}" here (2–${TEAM_NAME_LENGTH.max} characters).`);
    const wanted = (m.find((r) => r.abbreviation)?.abbreviation ?? "").toUpperCase();
    const abbr = TEAM_ABBREVIATION.test(wanted) && !taken.has(wanted) ? wanted : Y.abbreviate(name, taken);
    if (wanted && abbr !== wanted) warnings.push(`${name}: abbreviation "${wanted}" isn't valid or is taken; using ${abbr}.`);
    taken.add(abbr);
    const { rows: [row] } = await db.query<{ id: number }>(
      `INSERT INTO fantasy_teams (league_id, name, abbreviation, waiver_priority) VALUES ($1, $2, $3, $4) RETURNING id::int`,
      [leagueId, name, abbr, t.waiverPriority],
    );
    teamIds.set(t.key, row.id);
  }
  const teamId = (key: string | null) => (key === null ? null : teamIds.get(key) ?? null);

  let commissioner = false;
  const emails = new Set<string>();
  for (const r of members) {
    const id = teamIds.get(r.yahoo_team_key);
    if (id === undefined) {
      warnings.push(`members.csv: no team ${r.yahoo_team_key} in the snapshot; row skipped.`);
      continue;
    }
    for (const email of r.email.split(/[;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)) {
      if (!/^[^\s@]+@[^\s@]+$/.test(email)) warnings.push(`members.csv: "${email}" isn't an email; skipped.`);
      else if (emails.has(email)) warnings.push(`members.csv: ${email} is listed twice; only its first team counts.`);
      else {
        emails.add(email);
        const isCommish = YES.has(r.commissioner.toLowerCase());
        commissioner ||= isCommish;
        await db.query(
          `INSERT INTO league_members (league_id, email, fantasy_team_id, is_commissioner) VALUES ($1, $2, $3, $4)`,
          [leagueId, email, id, isCommish],
        );
      }
    }
  }
  const unclaimed = snap.teams.filter((t) => !members.some((r) => r.yahoo_team_key === t.key && r.email.trim()));
  if (unclaimed.length > 0) warnings.push(`No email for ${unclaimed.map((t) => t.name).join(", ")}: nobody can sign in as ${unclaimed.length === 1 ? "that team" : "those teams"} yet.`);
  if (!commissioner) warnings.push("Nobody is marked commissioner in members.csv, so nobody can change league settings.");

  // --- Settings: our defaults, then Yahoo's, then league-settings.json ---
  const base = (await getLeagueSettings(db as unknown as Pool, CURRENT_SEASON, null))!.data.settings;
  const fromYahoo = {
    ...yl.settings,
    ilSlots: yl.rosterSlots.IL ?? 0,
    ilPlusSlots: yl.rosterSlots["IL+"] ?? 0,
    ...(playoffStart !== null && { playoffStartWeek: playoffStart }),
  };
  const fromFile = has("league-settings.json") ? (read("league-settings.json") as Record<string, unknown>) : {};
  const parsed = parseSettings({ ...base, ...fromYahoo, ...fromFile }, snap.teams.length, snap.weeks.length);
  if ("error" in parsed) throw new Error(`League settings (ours, then Yahoo's, then league-settings.json): ${parsed.error}`);
  const s = parsed.settings;
  const slots = { ...yl.rosterSlots, IL: s.ilSlots, "IL+": s.ilPlusSlots };
  for (const k of ["IL", "IL+"] as const) if (slots[k] === 0) delete slots[k];
  await db.query(
    `UPDATE leagues SET
       waiver_type = $2, waiver_time = $3::time, time_zone = $4, waiver_days_of_week = $5, waiver_days = $6,
       waivers_after_game_start = $7, roster_slots = $8, il_statuses = $9,
       il_plus_statuses = $10, trade_review = $11, trade_review_days = $12,
       trade_veto_votes = $13, trade_deadline = $14, max_adds_per_week = $15, max_adds_per_season = $16,
       playoff_teams = $17, playoff_start_week = $18, toilet_bowl = $19, toilet_bowl_teams = $20,
       faab_budget = $21, faab_min_bid = $22, game_limits = $23, updated_at = now()
     WHERE id = $1`,
    [
      leagueId, s.waiverType, s.waiverTime, s.timeZone, s.waiverDaysOfWeek, s.waiverDays,
      s.waiversAfterGameStart, JSON.stringify(slots), s.ilStatuses,
      s.ilPlusStatuses, s.tradeReview, s.tradeReviewDays,
      s.tradeVetoVotes, s.tradeDeadline, s.maxAddsPerWeek, s.maxAddsPerSeason,
      s.playoffTeams, s.playoffStartWeek, s.toiletBowl, s.toiletBowlTeams,
      s.faabBudget, s.faabMinBid, s.gameLimits && JSON.stringify(s.gameLimits),
    ],
  );
  const { rows: [{ today }] } = await db.query<{ today: string }>(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today`, [s.timeZone]);
  if (today !== meta.today) {
    const msg = `The snapshot is from ${meta.today} but today is ${today} (${s.timeZone}): export again so rosters are current.`;
    if (STALE_OK) warnings.push(msg);
    else errors.push(`${msg} (--stale-ok imports it anyway.)`);
  }
  // Like a settings save: game limits apply from the next week on.
  await db.query(`UPDATE league_weeks SET game_limits = $2 WHERE league_id = $1 AND starts_on > $3::date`,
    [leagueId, s.gameLimits && JSON.stringify(s.gameLimits), today]);
  if (s.waiverType === "faab") {
    for (const t of snap.teams) {
      await db.query(`UPDATE fantasy_teams SET faab_balance = $2 WHERE id = $1`, [teamIds.get(t.key), Math.max(0, t.faabBalance ?? s.faabBudget)]);
    }
  }
  const weekOf = (date: string) => snap.weeks.find((w) => w.start <= date && date <= w.end);
  const current = weekOf(today);
  if (playoffStart !== null && current && ourWeek(current.week) >= playoffStart) {
    errors.push(`Week ${ourWeek(current.week)} is a playoff week: import before the playoffs start (brackets aren't imported).`);
  }
  notes.push(`League: "${yl.name}", ${snap.teams.length} teams, ${snap.weeks.length} weeks` +
    `${playoffStart !== null ? ` (playoffs from week ${playoffStart})` : ""}, ${s.waiverType} waivers, time zone ${s.timeZone}.`);

  // --- Schedule and finished weeks ---
  let pairs = 0;
  let finished = 0;
  const scheduled = new Set<number>();
  for (const m of snap.matchups) {
    if (m.isPlayoffs || m.teams.length !== 2) continue;
    const [a, b] = m.teams.map((t) => teamId(t.key));
    if (a === null || b === null) continue;
    const week = ourWeek(m.week);
    await db.query(`INSERT INTO matchups (league_id, week, team_a_id, team_b_id) VALUES ($1, $2, $3, $4)`, [leagueId, week, a, b]);
    pairs++;
    scheduled.add(week);
    const w = snap.weeks.find((x) => x.week === m.week);
    if (w && w.end < today) {
      if (m.status !== "postevent") warnings.push(`Week ${week} has ended but Yahoo calls it "${m.status}"; its results may not be final.`);
      for (const [i, t] of m.teams.entries()) {
        await db.query(`INSERT INTO week_results (league_id, week, fantasy_team_id, line) VALUES ($1, $2, $3, $4)`,
          [leagueId, week, i === 0 ? a : b, JSON.stringify(t.line)]);
      }
      finished++;
    }
  }
  const missing = snap.weeks.map((w) => ourWeek(w.week)).filter((w) => (playoffStart === null || w < playoffStart) && !scheduled.has(w));
  if (missing.length > 0) warnings.push(`No matchups for regular-season week(s) ${missing.join(", ")}.`);
  notes.push(`Schedule: ${pairs} matchups; ${finished} finished with Yahoo's results` +
    `${current ? `; week ${ourWeek(current.week)} (${current.start} to ${current.end}) is scored here from its lineups` : ""}.`);

  // --- Today's rosters: our slot rules, Yahoo's lineup where it fits them ---
  const today_ = todayRosters ?? new Map<string, Y.YahooRosterEntry[]>();
  const ids = [...today_.values()].flat().map((e) => pid(e.player)).filter((id): id is number => id !== null);
  const [{ rows: positions }, injuries] = await Promise.all([
    db.query<{ id: number; position: string | null; name: string }>(
      `SELECT id, nullif(position, '') AS position, first_name || ' ' || last_name AS name FROM players WHERE id = ANY($1)`, [ids],
    ),
    getInjuries(db, ids),
  ]);
  const info = new Map(positions.map((p) => [p.id, p]));
  const ilRules: IlRules = { il: { statuses: s.ilStatuses }, ilPlus: { statuses: s.ilPlusStatuses } };
  // When each player joined his current team, from the transactions.
  const joined = new Map<string, number>();
  for (const t of snap.transactions) {
    for (const p of t.players) if (p.destinationTeamKey) joined.set(`${p.destinationTeamKey}:${p.player.key}`, t.timestamp);
  }
  const todaySlots = new Map<number, Map<number, LineupSlot>>();
  let rostered = 0;
  for (const [key, entries] of today_) {
    const tid = teamId(key);
    if (tid === null) continue;
    const slotsToday = new Map<number, LineupSlot>();
    const check: Parameters<typeof rosterProblems>[0] = [];
    for (const e of entries) {
      const id = pid(e.player);
      if (id === null) continue;
      const p = info.get(id);
      const eligible = eligibleSlots(p?.position ?? null, ilEligibility(injuries.get(id)?.status ?? null, ilRules));
      let slot = Y.toSlot(e.position) ?? "BN";
      if (Y.toSlot(e.position) === null) warnings.push(`${p?.name}: Yahoo position "${e.position}" has no slot here; on the bench.`);
      // Starters must fit our positions (BALLDONTLIE's G/F/C); IL players stay put, like Yahoo, and get flagged below.
      if (isStarting(slot) && !eligible.includes(slot)) {
        warnings.push(`${p?.name} (${p?.position ?? "no position"}) can't play ${slot} here (Yahoo: ${e.player.eligiblePositions.join(", ")}); on the bench today.`);
        slot = "BN";
      }
      slotsToday.set(id, slot);
      check.push({ id, slot, eligible, name: p?.name ?? e.player.full });
      const at = joined.get(`${key}:${e.player.key}`);
      await db.query(
        `INSERT INTO roster_players (league_id, player_id, fantasy_team_id, slot, acquired_at) VALUES ($1, $2, $3, $4, $5)`,
        [leagueId, id, tid, slot, at ? new Date(at * 1000) : new Date(`${yl.startDate}T00:00:00Z`)],
      );
      rostered++;
    }
    todaySlots.set(tid, slotsToday);
    for (const problem of rosterProblems(check, slots)) {
      warnings.push(`${snap.teams.find((t) => t.key === key)?.name}'s roster is illegal here (no adds or claims until fixed): ${problem}`);
    }
  }

  // --- Every day's lineup so far (today's as adjusted above) ---
  const rows = { team: [] as number[], date: [] as string[], player: [] as number[], slot: [] as string[] };
  for (const [date, byTeam] of snap.rosters) {
    if (date > today) continue;
    for (const [key, entries] of byTeam) {
      const tid = teamId(key);
      if (tid === null) continue;
      for (const e of entries) {
        const id = pid(e.player);
        if (id === null) continue;
        rows.team.push(tid);
        rows.date.push(date);
        rows.player.push(id);
        rows.slot.push(date === today ? todaySlots.get(tid)?.get(id) ?? "BN" : Y.toSlot(e.position) ?? "BN");
      }
    }
  }
  await db.query(
    `INSERT INTO lineup_slots (league_id, fantasy_team_id, date, player_id, slot)
     SELECT $1, t, d::date, p, s::lineup_slot FROM unnest($2::bigint[], $3::text[], $4::int[], $5::text[]) AS x(t, d, p, s)
     ON CONFLICT DO NOTHING`,
    [leagueId, rows.team, rows.date, rows.player, rows.slot],
  );
  notes.push(`Rosters: ${rostered} players on ${todaySlots.size} teams; ${rows.team.length} daily lineup rows over ${snap.rosters.size} days.`);

  // --- Transactions (completed ones; pending trades and claims aren't imported) ---
  let txCount = 0;
  const lastDrop = new Map<number, number>();
  for (const t of snap.transactions) {
    if (t.status !== "successful") continue;
    const players = t.players
      .map((p) => ({ ...p, id: pid(p.player), from: p.sourceType === "team" ? teamId(p.sourceTeamKey) : null, to: p.destinationType === "team" ? teamId(p.destinationTeamKey) : null }))
      .filter((p) => p.id !== null && (p.from !== null || p.to !== null));
    if (players.length === 0) continue;
    const add = players.find((p) => p.type === "add");
    const drop = players.find((p) => p.type === "drop");
    const claim = add?.sourceType === "waivers";
    const type = { add: claim ? "waiver_claim" : "add", drop: "drop", "add/drop": claim ? "waiver_claim" : "add_drop", trade: "trade", commish: "commissioner" }[t.type];
    if (!type) continue;
    const team = t.type === "trade" ? teamId(t.traderTeamKey) : add?.to ?? drop?.from ?? players[0].to ?? players[0].from;
    const at = new Date(t.timestamp * 1000);
    const { rows: [tx] } = await db.query<{ id: number }>(
      `INSERT INTO transactions (league_id, type, status, team_id, trade_team_id, created_at, processed_at, faab_bid)
       VALUES ($1, $2, 'completed', $3, $4, $5, $5, $6) RETURNING id::int`,
      [leagueId, type, team, t.type === "trade" ? teamId(t.tradeeTeamKey) : null, at, claim ? t.faabBid : null],
    );
    for (const p of players) {
      await db.query(
        `INSERT INTO transaction_players (transaction_id, player_id, from_team_id, to_team_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [tx.id, p.id, p.from, p.to],
      );
      if (p.to === null && p.from !== null) lastDrop.set(p.id!, p.from);
    }
    txCount++;
  }

  // --- Waivers ---
  let onWaivers = 0;
  for (const w of snap.waivers) {
    const id = pid(w.player);
    if (id === null) continue;
    const { rowCount } = await db.query(
      `INSERT INTO waiver_players (league_id, player_id, clears_at, dropped_by_team_id)
       SELECT $1, $2, next_waiver_run($1, CASE WHEN $3::date IS NULL THEN now() ELSE ($3::date::timestamp AT TIME ZONE l.time_zone) END), $4
         FROM leagues l WHERE l.id = $1
          AND NOT EXISTS (SELECT 1 FROM roster_players r WHERE r.league_id = $1 AND r.player_id = $2)
       ON CONFLICT DO NOTHING`,
      [leagueId, id, w.clearsOn, lastDrop.get(id) ?? null],
    );
    onWaivers += rowCount ?? 0;
  }
  notes.push(`History: ${txCount} transactions; ${onWaivers} players on waivers.`);

  // --- Managers who have signed in before get their teams now ---
  let linked = 0;
  for (const email of emails) {
    const { rows: [user] } = await db.query<{ id: number }>(
      `SELECT id::int FROM users WHERE lower(email) = $1 ORDER BY google_sub LIKE 'mock:%', last_seen_at DESC LIMIT 1`, [email],
    );
    if (user) linked += await linkMemberships(db, user.id, email);
  }
  notes.push(`Managers: ${emails.size} emails for ${snap.teams.length - unclaimed.length} teams; ${linked} already signed in and linked, the rest link on first sign-in.`);
}

async function main() {
  if (!dir) throw new Error("Usage: npm run yahoo:import -- <snapshot dir> [--apply] [--replace] [--stale-ok]");
  if (!has("meta.json")) throw new Error(`${dir} isn't a snapshot (no meta.json); run npm run yahoo:export first.`);
  const snap = loadSnapshot();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await run(db, snap);
    const commit = APPLY && errors.length === 0;
    await db.query(commit ? "COMMIT" : "ROLLBACK");

    console.log(`Yahoo import from ${dir} (snapshot ${snap.meta.exportedAt})\n`);
    for (const n of notes) console.log(`  ${n}`);
    if (warnings.length > 0) console.log(`\nWarnings (${warnings.length}):`);
    for (const w of warnings) console.log(`  - ${w}`);
    if (errors.length > 0) console.log(`\nErrors (${errors.length}), so nothing was saved:`);
    for (const e of errors) console.log(`  - ${e}`);
    console.log(commit ? "\nImported." : errors.length > 0 ? "" : "\nDry run: nothing was saved. Add --apply to import.");
    if (errors.length > 0) process.exitCode = 1;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

// Replaces this season's league with a Yahoo league, from a folder of CSVs built
// from Yahoo's league pages (formats in src/lib/yahoo/csv.ts; the
// yahoo-csv-refresh skill builds them). A dry run by default: everything runs
// in one transaction that is rolled back, and the report says what would
// change. --apply commits it.
//   npm run yahoo:import -- yahoo-csv/my-league              # dry run
//   npm run yahoo:import -- yahoo-csv/my-league --apply      # first import
//   npm run yahoo:import -- yahoo-csv/my-league --apply --replace   # over an existing league
//
// What carries over: teams and their managers' emails, the schedule (Yahoo's
// matchup weeks and pairings), every finished week's result exactly as Yahoo
// scored it (week_results), each team's lineup on every day in lineups.csv,
// today's rosters, waiver order, FAAB balances, the settings in league.json and,
// from transactions.csv, completed transactions (league history, adds counted
// against the weekly and season limits, when each rostered player was acquired)
// and the players they left on waivers.
// What doesn't: pending trades and claims (managers resubmit them), lineups set
// ahead past this week, and a playoff bracket in progress (import before the
// playoffs start).
//
// Also read from the folder:
//   league-settings.json   optional: settings to use instead of league.json's or our defaults, in the
//                          /league/settings shape (LeagueSettings in src/lib/types.ts), e.g.
//                          {"timeZone": "America/Los_Angeles", "gameLimits": {"total": 40, "slots": {}}}
//   player-overrides.csv   Yahoo players matched by hand (yahoo_player_key -> player_id). The import
//                          adds a row with a blank player_id for each player it couldn't match.
//
// Users and their sign-ins are kept: managers who have signed in before are
// linked to their teams right away, everyone else on first sign-in
// (src/lib/auth/members.ts).
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { canonicalEmail, linkMemberships } from "../../src/lib/auth/members";
import { eligibleSlots, ilEligibility, isStarting, rosterProblems, type IlRules } from "../../src/lib/lineup/rules";
import { getInjuries } from "../../src/lib/queries/injuries";
import { getLeagueSettings, parseSettings } from "../../src/lib/queries/settings";
import { CURRENT_SEASON, TEAM_ABBREVIATION, TEAM_NAME_LENGTH, type LineupSlot } from "../../src/lib/types";
import { snapshotFromCsv } from "../../src/lib/yahoo/csv";
import * as Y from "../../src/lib/yahoo/parse";

const dir = process.argv.slice(2).find((a) => !a.startsWith("--"));
const APPLY = process.argv.includes("--apply");
const REPLACE = process.argv.includes("--replace");
const STALE_OK = process.argv.includes("--stale-ok");

const read = (path: string): unknown => JSON.parse(readFileSync(join(dir!, path), "utf8"));
const has = (path: string) => existsSync(join(dir!, path));

const errors: string[] = [];
const warnings: string[] = [];
const notes: string[] = [];

type Snapshot = Y.ImportSnapshot;
/** Manager emails per team, from teams.csv (yahoo_team_key, email, commissioner, abbreviation). */
let members: Record<string, string>[] = [];

function loadSnapshot(): Snapshot {
  const text = (f: string) => (has(f) ? readFileSync(join(dir!, f), "utf8") : "");
  for (const f of ["teams.csv", "schedule.csv", "results.csv", "rosters.csv"]) if (!has(f)) errors.push(`${f} is missing.`);
  const csv = snapshotFromCsv({
    league: read("league.json"), teams: text("teams.csv"), schedule: text("schedule.csv"),
    results: text("results.csv"), rosters: text("rosters.csv"), lineups: text("lineups.csv"),
    transactions: text("transactions.csv"),
  });
  errors.push(...csv.errors);
  members = csv.members;
  return csv.snapshot;
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
    for (const entries of byTeam.values()) for (const e of entries) note(e.player, date === snap.meta.today ? "roster" : date < snap.meta.today ? "past lineups" : "upcoming lineups");
  }
  for (const tx of snap.transactions) for (const m of tx.moves) note(m.player, "transactions");

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
  if (!todayRosters || todayRosters.size !== snap.teams.length) errors.push(`The snapshot has no rosters for ${meta.today} for every team; rebuild the CSVs.`);

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
      warnings.push(`teams.csv: no team ${r.yahoo_team_key} in the snapshot; row skipped.`);
      continue;
    }
    for (const email of r.email.split(/[;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)) {
      if (!/^[^\s@]+@[^\s@]+$/.test(email)) warnings.push(`teams.csv: "${email}" isn't an email; skipped.`);
      else if (emails.has(email)) warnings.push(`teams.csv: ${email} is listed twice; only its first team counts.`);
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
  if (!commissioner) warnings.push("Nobody is marked commissioner in teams.csv, so nobody can change league settings.");

  // --- Settings: our defaults, then league.json's, then league-settings.json ---
  const base = (await getLeagueSettings(db as unknown as Pool, CURRENT_SEASON, null))!.data.settings;
  const fromYahoo = {
    ...yl.settings,
    ilSlots: yl.rosterSlots.IL ?? 0,
    ilPlusSlots: yl.rosterSlots["IL+"] ?? 0,
    ...(playoffStart !== null && { playoffStartWeek: playoffStart }),
  };
  const fromFile = has("league-settings.json") ? (read("league-settings.json") as Record<string, unknown>) : {};
  const parsed = parseSettings({ ...base, ...fromYahoo, ...fromFile }, snap.teams.length, snap.weeks.length);
  if ("error" in parsed) throw new Error(`League settings (ours, then league.json's, then league-settings.json): ${parsed.error}`);
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
       faab_budget = $21, faab_min_bid = $22, game_limits = $23, claims_ignore_il_status = $24,
       all_adds_by_claim = $25, updated_at = now()
     WHERE id = $1`,
    [
      leagueId, s.waiverType, s.waiverTime, s.timeZone, s.waiverDaysOfWeek, s.waiverDays,
      s.waiversAfterGameStart, JSON.stringify(slots), s.ilStatuses,
      s.ilPlusStatuses, s.tradeReview, s.tradeReviewDays,
      s.tradeVetoVotes, s.tradeDeadline, s.maxAddsPerWeek, s.maxAddsPerSeason,
      s.playoffTeams, s.playoffStartWeek, s.toiletBowl, s.toiletBowlTeams,
      s.faabBudget, s.faabMinBid, s.gameLimits && JSON.stringify(s.gameLimits), s.claimsIgnoreIlStatus, s.allAddsByClaim,
    ],
  );
  const { rows: [{ today }] } = await db.query<{ today: string }>(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today`, [s.timeZone]);
  if (today !== meta.today) {
    const msg = `The snapshot is from ${meta.today} but today is ${today} (${s.timeZone}): rebuild the CSVs so rosters are current.`;
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
        warnings.push(`${p?.name} (${p?.position ?? "no position"}) can't play ${slot} here (Yahoo: ${e.player.eligiblePositions.join(", ")}); keeps Yahoo's lineup through this week, on the bench after.`);
        slot = "BN";
      }
      slotsToday.set(id, slot);
      check.push({ id, slot, eligible, name: p?.name ?? e.player.full });
      await db.query(
        `INSERT INTO roster_players (league_id, player_id, fantasy_team_id, slot, acquired_at) VALUES ($1, $2, $3, $4, $5)`,
        [leagueId, id, tid, slot, new Date(`${yl.startDate}T00:00:00Z`)],
      );
      rostered++;
    }
    todaySlots.set(tid, slotsToday);
    for (const problem of rosterProblems(check, slots)) {
      warnings.push(`${snap.teams.find((t) => t.key === key)?.name}'s roster is illegal here (no adds or claims until fixed): ${problem}`);
    }
  }

  // --- Every day's lineup this week, as Yahoo has it (including days set ahead) ---
  const rows = { team: [] as number[], date: [] as string[], player: [] as number[], slot: [] as string[] };
  for (const [date, byTeam] of snap.rosters) {
    for (const [key, entries] of byTeam) {
      const tid = teamId(key);
      if (tid === null) continue;
      for (const e of entries) {
        const id = pid(e.player);
        if (id === null) continue;
        if (date > meta.today && !todaySlots.get(tid)?.has(id)) {
          warnings.push(`lineups.csv: ${e.player.full} is in a ${date} lineup but not on that team today; skipped.`);
          continue;
        }
        rows.team.push(tid);
        rows.date.push(date);
        rows.player.push(id);
        rows.slot.push(Y.toSlot(e.position) ?? "BN");
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

  await importTransactions(db, snap, leagueId, teamId, pid, s.timeZone, s.waiverDays, today);

  // --- Managers who have signed in before get their teams now ---
  // Matched by canonicalEmail, so "a.b@gmail.com" signed in finds a team listed as "ab@gmail.com".
  const { rows: identities } = await db.query<{ id: number; email: string }>(
    `SELECT u.id::int, i.email FROM user_identities i JOIN users u ON u.id = i.user_id
      WHERE i.email_verified ORDER BY i.provider = 'mock', u.last_seen_at DESC`,
  );
  const userByEmail = new Map<string, number>();
  for (const i of identities) {
    const key = canonicalEmail(i.email);
    if (!userByEmail.has(key)) userByEmail.set(key, i.id);
  }
  let linked = 0;
  for (const email of emails) {
    const userId = userByEmail.get(canonicalEmail(email));
    if (userId) linked += await linkMemberships(db, userId, email);
  }
  notes.push(`Managers: ${emails.size} emails for ${snap.teams.length - unclaimed.length} teams; ${linked} already signed in and linked, the rest link on first sign-in.`);
}

/**
 * Yahoo's completed transactions, as if made here: the League page's history and
 * each player's, adds counted against the limits (countAdds), and roster_players.acquired_at.
 * A player dropped within the waiver period and not picked up since goes on waivers.
 */
async function importTransactions(
  db: PoolClient, snap: Snapshot, leagueId: number, teamId: (key: string | null) => number | null,
  pid: (p: Y.YahooPlayer) => number | null, leagueTz: string, waiverDays: number, today: string,
) {
  if (snap.transactions.length === 0) {
    notes.push("Transactions: none (no transactions.csv), so no history, add counts or players on waivers.");
    return;
  }
  const tz = snap.transactionsTimeZone ?? leagueTz;
  const { rowCount: known } = await db.query(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [tz]);
  if (!known) {
    errors.push(`league.json: transactionsTimeZone "${tz}" isn't a time zone (e.g. "America/Los_Angeles").`);
    return;
  }
  let saved = 0;
  let moves = 0;
  for (const tx of snap.transactions) {
    const players = new Map<number, { from: number | null; to: number | null }>();
    for (const m of tx.moves) {
      const id = pid(m.player);
      if (id !== null) players.set(id, { from: teamId(m.from), to: teamId(m.to) });
    }
    if (players.size === 0) continue;
    const { rows: [row] } = await db.query<{ id: number; day: string }>(
      `INSERT INTO transactions (league_id, type, status, team_id, trade_team_id, faab_bid, created_at, processed_at, accepted_at)
       SELECT $1, $2, 'completed', $3, $4, $5, x.at, x.at, CASE WHEN $2 = 'trade' THEN x.at END
         FROM (SELECT ($6::timestamp AT TIME ZONE $7) AS at) x
       RETURNING id::int, to_char((created_at AT TIME ZONE $8)::date, 'YYYY-MM-DD') AS day`,
      [leagueId, tx.type, teamId(tx.team), teamId(tx.tradeTeam), tx.type === "waiver_claim" ? tx.faabBid : null, tx.at, tz, leagueTz],
    );
    if (row.day > today) errors.push(`transactions.csv: transaction ${tx.id} (${tx.at}, ${tz}) is after today (${today}); rebuild the CSVs.`);
    for (const [player, { from, to }] of players) {
      await db.query(
        `INSERT INTO transaction_players (transaction_id, player_id, from_team_id, to_team_id) VALUES ($1, $2, $3, $4)`,
        [row.id, player, from, to],
      );
      moves++;
    }
    saved++;
  }

  // Rostered players were acquired by their latest move to that team (else the season start, as set above).
  const { rowCount: acquired } = await db.query(
    `UPDATE roster_players rp SET acquired_at = x.at
       FROM (SELECT DISTINCT ON (tp.player_id, tp.to_team_id) tp.player_id, tp.to_team_id, t.created_at AS at
               FROM transaction_players tp JOIN transactions t ON t.id = tp.transaction_id
              WHERE t.league_id = $1 AND tp.to_team_id IS NOT NULL
              ORDER BY tp.player_id, tp.to_team_id, t.created_at DESC, t.id DESC) x
      WHERE rp.league_id = $1 AND rp.player_id = x.player_id AND rp.fantasy_team_id = x.to_team_id`,
    [leagueId],
  );
  // On waivers, like a drop here (runRosterMove): until the first waiver run at least waiver_days after the drop.
  const { rows: onWaivers } = waiverDays <= 0 ? { rows: [] } : await db.query<{ name: string; clears: string }>(
    `WITH last AS (
       SELECT DISTINCT ON (tp.player_id) tp.player_id, tp.from_team_id, tp.to_team_id, t.created_at AS at
         FROM transaction_players tp JOIN transactions t ON t.id = tp.transaction_id
        WHERE t.league_id = $1
        ORDER BY tp.player_id, t.created_at DESC, t.id DESC
     ), w AS (
       INSERT INTO waiver_players (league_id, player_id, clears_at, dropped_by_team_id)
       SELECT $1, l.player_id, next_waiver_run($1, l.at + make_interval(days => $2)), l.from_team_id
         FROM last l
        WHERE l.to_team_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM roster_players rp WHERE rp.league_id = $1 AND rp.player_id = l.player_id)
          AND next_waiver_run($1, l.at + make_interval(days => $2)) > now()
       RETURNING player_id, clears_at
     )
     SELECT p.first_name || ' ' || p.last_name AS name,
            to_char(w.clears_at AT TIME ZONE $3, 'Mon FMDD FMHH12:MI am') AS clears
       FROM w JOIN players p ON p.id = w.player_id ORDER BY w.clears_at, p.last_name`,
    [leagueId, waiverDays, leagueTz],
  );
  // A rostered player whose last move here isn't onto his team: the files disagree.
  const { rows: mismatched } = await db.query<{ name: string }>(
    `SELECT p.first_name || ' ' || p.last_name AS name
       FROM roster_players rp JOIN players p ON p.id = rp.player_id
       JOIN LATERAL (SELECT tp.to_team_id FROM transaction_players tp JOIN transactions t ON t.id = tp.transaction_id
                      WHERE t.league_id = $1 AND tp.player_id = rp.player_id
                      ORDER BY t.created_at DESC, t.id DESC LIMIT 1) last ON true
      WHERE rp.league_id = $1 AND last.to_team_id IS DISTINCT FROM rp.fantasy_team_id
      ORDER BY p.last_name`,
    [leagueId],
  );
  if (mismatched.length > 0) {
    warnings.push(`transactions.csv doesn't end with ${mismatched.map((m) => m.name).join(", ")} on the team rosters.csv has; check both are from today.`);
  }
  notes.push(`Transactions: ${saved} (${moves} player moves, times in ${tz}); ${acquired} rostered players' acquired dates; ` +
    `${onWaivers.length} on waivers${onWaivers.length > 0 ? ` (${onWaivers.map((w) => `${w.name} until ${w.clears}`).join(", ")})` : ""}.`);
}

async function main() {
  if (!dir) throw new Error("Usage: npm run yahoo:import -- <CSV folder> [--apply] [--replace] [--stale-ok]");
  if (!has("league.json")) throw new Error(`${dir} has no league.json (formats in src/lib/yahoo/csv.ts).`);
  const snap = loadSnapshot();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await run(db, snap);
    const commit = APPLY && errors.length === 0;
    await db.query(commit ? "COMMIT" : "ROLLBACK");

    console.log(`Yahoo import from ${dir} (rosters as of ${snap.meta.today})\n`);
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

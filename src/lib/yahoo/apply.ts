// Writes a Yahoo snapshot (parse.ts ImportSnapshot, from the API via
// fromApi.ts or from CSVs via csv.ts) into this season's league. Run inside a
// transaction the caller owns: it commits only when the report has no errors.
//
// Two modes:
//   replace  Deletes this season's league and builds it again from the snapshot
//            (scripts/yahoo/import.ts --replace).
//   upsert   Updates the league in place, keyed by Yahoo keys, so ids stay
//            stable: fantasy_teams by yahoo_team_key (the first time, by name),
//            weeks by number, settings and standings overwritten, each fetched
//            week's matchups and results (week_results: finished weeks final,
//            the current one live, final = false) replaced, today's rosters
//            and the fetched days' lineup_slots made to match Yahoo's, and
//            transactions appended once (transactions.yahoo_key). Parts the
//            snapshot doesn't carry (no rosters, no scoreboard for a week) are
//            left alone. Running it twice changes nothing the second time.
// Users, sign-ins, watchlists and push subscriptions are never touched; league
// members only when the CSVs list them (teams.csv), since Yahoo doesn't share
// other managers' emails.
//
// Sources differ a little: "csv" is strict (an unmatched rostered player is an
// error, fix player-overrides.csv) and skips playoff matchups; "api" leaves an
// unmatched player off with a warning (match him by hand in yahoo_players),
// remembers matches in yahoo_players, and mirrors playoff and consolation
// pairings and the current week's live totals.
import type { Pool, PoolClient } from "pg";
import { canonicalEmail, linkMemberships } from "../auth/members";
import { eligibleSlots, ilEligibility, isStarting, rosterProblems, type IlRules } from "../lineup/rules";
import { getInjuries } from "../queries/injuries";
import { getLeagueSettings, parseSettings } from "../queries/settings";
import { CURRENT_SEASON, TEAM_ABBREVIATION, TEAM_NAME_LENGTH, type LineupSlot } from "../types";
import * as Y from "./parse";

export interface ApplyOptions {
  mode: "replace" | "upsert";
  source: "api" | "csv";
  /** teams.csv rows (yahoo_team_key, email, commissioner, abbreviation); undefined leaves league_members alone. */
  members?: Record<string, string>[];
  /** Settings over Yahoo's (league-settings.json), in the LeagueSettings shape. */
  settingsOverride?: Record<string, unknown>;
  /** Players matched by hand, snapshot player key -> our id (player-overrides.csv). */
  playerOverrides?: Map<string, number>;
  /** Import a snapshot from another day anyway (CSV --stale-ok). */
  staleOk?: boolean;
}

export interface UnmatchedPlayer {
  key: string;
  name: string;
  team: string;
  positions: string;
  where: string;
}

export interface ApplyReport {
  leagueId: number | null;
  notes: string[];
  warnings: string[];
  /** Any error means the caller must roll back. */
  errors: string[];
  unmatched: UnmatchedPlayer[];
}

const YES = new Set(["yes", "y", "true", "1", "x"]);

/** A stable key for a CSV transaction (transactions.csv ids aren't stable across exports). */
export function csvTransactionKey(tx: Y.YahooTransaction): string {
  const moves = tx.moves.map((m) => `${m.player.key}>${m.from ?? ""}>${m.to ?? ""}`).sort().join(",");
  return `csv:${tx.at}|${tx.type}|${tx.failureReason === null ? "done" : "failed"}|${moves}`;
}

/** The playoff bracket a mirrored playoff matchup goes in. */
function bracketOf(m: Y.YahooMatchup): "playoffs" | "toilet_bowl" | null {
  return m.isPlayoffs ? (m.isConsolation ? "toilet_bowl" : "playoffs") : null;
}

export async function applySnapshot(db: PoolClient, snap: Y.ImportSnapshot, opts: ApplyOptions): Promise<ApplyReport> {
  const report: ApplyReport = { leagueId: null, notes: [], warnings: [], errors: [], unmatched: [] };
  const { errors, warnings, notes } = report;
  const api = opts.source === "api";
  const { league: yl, meta } = snap;

  if (yl.season !== CURRENT_SEASON) errors.push(`The Yahoo league is season ${yl.season}; this app is on ${CURRENT_SEASON}.`);
  const wanted = Object.values(Y.YAHOO_STAT_IDS).sort();
  if (JSON.stringify([...yl.statIds].sort()) !== JSON.stringify(wanted)) {
    errors.push(`The Yahoo league scores stat ids ${yl.statIds.join(", ")}; this app scores the nine categories (${wanted.join(", ")}).`);
  }
  if (snap.teams.length < 2) errors.push("The snapshot has no teams.");
  if (snap.weeks.length === 0) errors.push("The snapshot has no matchup weeks.");
  const todayRosters = snap.rosters.get(meta.today);
  if (opts.source === "csv" && (!todayRosters || todayRosters.size !== snap.teams.length)) {
    errors.push(`The snapshot has no rosters for ${meta.today} for every team; rebuild the CSVs.`);
  }
  if (api && todayRosters && todayRosters.size !== snap.teams.length) {
    errors.push(`Yahoo returned today's roster for ${todayRosters.size} of ${snap.teams.length} teams.`);
  }
  if (errors.length > 0) return report;

  const playerIds = await matchPlayers(db, snap, opts, report);
  const pid = (p: Y.YahooPlayer) => playerIds.get(p.key) ?? null;

  // --- The league ---
  const { rows: existing } = await db.query<{ id: number; name: string; teams: number; imported_at: Date | null; owned: number; yahoo_league_key: string | null }>(
    `SELECT l.id::int, l.name, l.imported_at, l.yahoo_league_key,
            (SELECT count(*)::int FROM fantasy_teams ft WHERE ft.league_id = l.id) AS teams,
            (SELECT count(*)::int FROM fantasy_teams ft WHERE ft.league_id = l.id AND ft.owner_user_id IS NOT NULL) AS owned
       FROM leagues l WHERE l.season = $1 ORDER BY l.id`,
    [CURRENT_SEASON],
  );
  let leagueId: number;
  if (opts.mode === "replace" || existing.length === 0) {
    for (const l of existing) {
      notes.push(`Replaces the existing league "${l.name}" (${l.teams} teams, ${l.owned} with managers` +
        `${l.imported_at ? `, imported ${l.imported_at.toISOString()}` : ""}): everything in it is deleted.`);
    }
    await db.query(`DELETE FROM leagues WHERE season = $1`, [CURRENT_SEASON]);
    const { rows: [row] } = await db.query<{ id: number }>(
      `INSERT INTO leagues (name, season, max_teams, roster_slots, yahoo_league_key, imported_at)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING id::int`,
      [yl.name, CURRENT_SEASON, snap.teams.length, JSON.stringify(yl.rosterSlots), yl.key],
    );
    leagueId = row.id;
  } else {
    if (existing.length > 1) {
      errors.push(`There are ${existing.length} ${CURRENT_SEASON} leagues; replace them (--replace) to start over from Yahoo.`);
      return report;
    }
    const l = existing[0];
    const known = l.yahoo_league_key;
    if (api && known && known !== "csv" && known !== yl.key) {
      errors.push(`This season's league mirrors Yahoo league ${known}, not ${yl.key}. Reconnect to that league, or replace it (npm run yahoo:sync -- --replace).`);
      return report;
    }
    leagueId = l.id;
    await db.query(
      `UPDATE leagues SET name = $2, max_teams = $3, yahoo_league_key = $4
        WHERE id = $1 AND (name, max_teams, yahoo_league_key) IS DISTINCT FROM ($2, $3, $4)`,
      [leagueId, yl.name, snap.teams.length, api || !known ? yl.key : known],
    );
  }
  report.leagueId = leagueId;

  // Our week numbers start at 1.
  const ourWeek = (yahooWeek: number) => yahooWeek - yl.startWeek + 1;
  const playoffStart = yl.playoffStartWeek === null ? null : ourWeek(yl.playoffStartWeek);
  for (const w of snap.weeks) {
    await db.query(
      `INSERT INTO league_weeks (league_id, week, starts_on, ends_on, is_playoffs) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (league_id, week) DO UPDATE SET starts_on = EXCLUDED.starts_on, ends_on = EXCLUDED.ends_on, is_playoffs = EXCLUDED.is_playoffs
        WHERE (league_weeks.starts_on, league_weeks.ends_on, league_weeks.is_playoffs)
              IS DISTINCT FROM (EXCLUDED.starts_on, EXCLUDED.ends_on, EXCLUDED.is_playoffs)`,
      [leagueId, ourWeek(w.week), w.start, w.end, playoffStart !== null && ourWeek(w.week) >= playoffStart],
    );
  }

  // --- Teams ---
  const teamIds = await applyTeams(db, leagueId, snap, opts, report);
  const teamId = (key: string | null) => (key === null ? null : teamIds.get(key) ?? null);
  const emails = opts.members ? await applyMembers(db, leagueId, snap, opts.members, teamIds, report) : null;

  // --- Settings: ours (or our defaults), then Yahoo's, then league-settings.json ---
  const before = (await getLeagueSettings(db as unknown as Pool, CURRENT_SEASON, null))!.data.settings;
  const { rows: [{ weeks: weekCount }] } = await db.query<{ weeks: number }>(
    `SELECT count(*)::int AS weeks FROM league_weeks WHERE league_id = $1`, [leagueId],
  );
  const fromYahoo = {
    // Ours (veto votes) can't outnumber the teams that could vote.
    tradeVetoVotes: Math.min(before.tradeVetoVotes, Math.max(1, snap.teams.length - 2)),
    ...yl.settings,
    ilSlots: yl.rosterSlots.IL ?? 0,
    ilPlusSlots: yl.rosterSlots["IL+"] ?? 0,
    ...(playoffStart !== null && { playoffStartWeek: playoffStart }),
  };
  const parsed = parseSettings({ ...before, ...fromYahoo, ...opts.settingsOverride }, snap.teams.length, weekCount);
  if ("error" in parsed) {
    errors.push(`League settings (ours, then Yahoo's${opts.settingsOverride ? ", then league-settings.json" : ""}): ${parsed.error}`);
    return report;
  }
  const s = parsed.settings;
  const slots: Partial<Record<LineupSlot, number>> = { ...yl.rosterSlots, IL: s.ilSlots, "IL+": s.ilPlusSlots };
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
     WHERE id = $1 AND (
       waiver_type, waiver_time, time_zone, waiver_days_of_week, waiver_days, waivers_after_game_start, roster_slots,
       il_statuses, il_plus_statuses, trade_review, trade_review_days, trade_veto_votes, trade_deadline,
       max_adds_per_week, max_adds_per_season, playoff_teams, playoff_start_week, toilet_bowl, toilet_bowl_teams,
       faab_budget, faab_min_bid, game_limits, claims_ignore_il_status, all_adds_by_claim
     ) IS DISTINCT FROM (
       $2, $3::time, $4, $5::int[], $6, $7, $8::jsonb, $9::text[], $10::text[], $11, $12, $13, $14::date, $15::int, $16::int,
       $17, $18::int, $19, $20, $21, $22, $23::jsonb, $24, $25
     )`,
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
    const msg = `The snapshot is from ${meta.today} but today is ${today} (${s.timeZone})` +
      (api ? "; refresh again." : ": rebuild the CSVs so rosters are current.");
    if (opts.staleOk) warnings.push(msg);
    else errors.push(api ? msg : `${msg} (--stale-ok imports it anyway.)`);
  }
  // Like a settings save: game limits apply from the next week on.
  await db.query(
    `UPDATE league_weeks SET game_limits = $2 WHERE league_id = $1 AND starts_on > $3::date AND game_limits IS DISTINCT FROM $2::jsonb`,
    [leagueId, s.gameLimits && JSON.stringify(s.gameLimits), today],
  );
  if (s.waiverType === "faab") {
    for (const t of snap.teams) {
      await db.query(`UPDATE fantasy_teams SET faab_balance = $2 WHERE id = $1 AND faab_balance IS DISTINCT FROM $2`,
        [teamIds.get(t.key), Math.max(0, t.faabBalance ?? s.faabBudget)]);
    }
  }
  for (const st of snap.standings ?? []) {
    const id = teamId(st.key);
    if (id === null) continue;
    const standing = { rank: st.rank, wins: st.wins, losses: st.losses, ties: st.ties };
    await db.query(`UPDATE fantasy_teams SET yahoo_standing = $2 WHERE id = $1 AND yahoo_standing IS DISTINCT FROM $2::jsonb`,
      [id, JSON.stringify(standing)]);
  }
  const weekOf = (date: string) => snap.weeks.find((w) => w.start <= date && date <= w.end);
  const current = weekOf(today);
  if (!api && playoffStart !== null && current && ourWeek(current.week) >= playoffStart) {
    warnings.push(`Week ${ourWeek(current.week)} is a playoff week: the CSVs don't carry brackets, so they aren't imported.`);
  }
  notes.push(`League: "${yl.name}", ${snap.teams.length} teams, ${snap.weeks.length} weeks` +
    `${playoffStart !== null ? ` (playoffs from week ${playoffStart})` : ""}, ${s.waiverType} waivers, time zone ${s.timeZone}.`);

  await applyMatchups(db, leagueId, snap, { api, today, ourWeek, playoffStart, teamId }, report);
  if (todayRosters) await applyRosters(db, leagueId, snap, todayRosters, { pid, teamId, ilRules: { il: { statuses: s.ilStatuses }, ilPlus: { statuses: s.ilPlusStatuses } }, slots }, report);
  await applyTransactions(db, snap, leagueId, teamId, pid, { api, leagueTz: s.timeZone, waiverDays: s.waiverDays, today }, report);

  // --- Managers who have signed in before get their teams now ---
  if (emails) {
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
    for (const email of emails.all) {
      const userId = userByEmail.get(canonicalEmail(email));
      if (userId) linked += await linkMemberships(db, userId, email);
    }
    notes.push(`Managers: ${emails.all.size} emails for ${snap.teams.length - emails.unclaimed} teams; ${linked} newly linked to signed-in users, the rest link on first sign-in.`);
  }
  return report;
}

/** Snapshot player key -> our player id: by hand (overrides, or yahoo_players rows matched by hand), then by name. */
async function matchPlayers(db: PoolClient, snap: Y.ImportSnapshot, opts: ApplyOptions, report: ApplyReport): Promise<Map<string, number>> {
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

  const { rows } = await db.query<{ id: number; first_name: string; last_name: string; abbr: string | null }>(
    `SELECT p.id, p.first_name, p.last_name, t.abbreviation AS abbr FROM players p LEFT JOIN teams t ON t.id = p.team_id`,
  );
  const ours: Y.OurPlayer[] = rows.map((r) => ({ id: r.id, firstName: r.first_name, lastName: r.last_name, team: r.abbr }));
  const known = new Set(ours.map((p) => p.id));

  const byHand = new Map(opts.playerOverrides ?? []);
  const remembered = new Map<string, { player_id: number | null; matched_by: string; name: string; nba_team: string }>();
  if (opts.source === "api" && all.size > 0) {
    const { rows: saved } = await db.query<{ yahoo_player_key: string; player_id: number | null; matched_by: string; name: string; nba_team: string }>(
      `SELECT yahoo_player_key, player_id, matched_by, name, nba_team FROM yahoo_players WHERE yahoo_player_key = ANY($1)`, [[...all.keys()]],
    );
    for (const r of saved) {
      remembered.set(r.yahoo_player_key, r);
      if (r.matched_by === "hand" && r.player_id !== null) byHand.set(r.yahoo_player_key, r.player_id);
    }
  }

  const out = new Map<string, number>();
  let hand = 0;
  for (const [key, { player, where }] of all) {
    const manual = byHand.get(key);
    const id = manual ?? Y.matchPlayer(player, ours);
    if (manual !== undefined) hand++;
    if (opts.source === "api") {
      const r = remembered.get(key);
      if (!r || (r.matched_by !== "hand" && (r.player_id !== id || r.name !== player.full || r.nba_team !== player.team))) {
        await db.query(
          `INSERT INTO yahoo_players (yahoo_player_key, player_id, name, nba_team) VALUES ($1, $2, $3, $4)
           ON CONFLICT (yahoo_player_key) DO UPDATE SET player_id = EXCLUDED.player_id, name = EXCLUDED.name,
             nba_team = EXCLUDED.nba_team, updated_at = now() WHERE yahoo_players.matched_by = 'name'`,
          [key, id !== null && known.has(id) ? id : null, player.full, player.team],
        );
      }
    }
    if (id !== null && known.has(id)) {
      out.set(key, id);
      continue;
    }
    if (id !== null) report.warnings.push(`${key} is matched by hand to player ${id}, but there's no player ${id}.`);
    report.unmatched.push({ key, name: player.full, team: player.team, positions: player.eligiblePositions.join("/"), where: [...where].join("; ") });
    const msg = `No match for ${player.full} (${player.team || "FA"}, ${key}) in ${[...where].join(", ")}.`;
    if (opts.source === "csv" && where.has("roster")) report.errors.push(`${msg} He's on a roster today: add his player id to player-overrides.csv.`);
    else if (opts.source === "api") report.warnings.push(`${msg} Left out; match him by hand: UPDATE yahoo_players SET player_id = <id>, matched_by = 'hand' WHERE yahoo_player_key = '${key}'.`);
    else report.warnings.push(`${msg} Skipped there.`);
  }
  report.notes.push(`Players: ${out.size} matched (${hand} by hand), ${report.unmatched.length} unmatched.`);
  return out;
}

/** Yahoo team key -> fantasy_teams.id, creating, linking (first time, by name) and renaming teams. */
async function applyTeams(
  db: PoolClient, leagueId: number, snap: Y.ImportSnapshot, opts: ApplyOptions, report: ApplyReport,
): Promise<Map<string, number>> {
  const { rows: existing } = await db.query<{ id: number; name: string; abbreviation: string; yahoo_team_key: string | null; waiver_priority: number | null }>(
    `SELECT id::int, name, abbreviation, yahoo_team_key, waiver_priority FROM fantasy_teams WHERE league_id = $1 ORDER BY id`, [leagueId],
  );
  const taken = new Set(existing.map((t) => t.abbreviation));
  const ids = new Map<string, number>();
  const used = new Set<number>();
  const norm = (n: string) => n.trim().toLowerCase();
  let linked = 0;
  let created = 0;
  for (const t of snap.teams) {
    const m = (opts.members ?? []).filter((r) => r.yahoo_team_key === t.key);
    let name = t.name.trim().slice(0, TEAM_NAME_LENGTH.max);
    if (name.length < TEAM_NAME_LENGTH.min) name = `Team ${t.key.split(".t.")[1] ?? ""}`.trim();
    if (name !== t.name) report.warnings.push(`Team "${t.name}" is named "${name}" here (2–${TEAM_NAME_LENGTH.max} characters).`);

    // By key; the first time, by name among teams with no Yahoo key yet (or a CSV one, moving to the API).
    let row = existing.find((e) => e.yahoo_team_key === t.key && !used.has(e.id));
    if (!row && !t.key.startsWith("csv.")) {
      row = existing.find((e) => !used.has(e.id) && (e.yahoo_team_key === null || e.yahoo_team_key.startsWith("csv.")) && norm(e.name) === norm(t.name));
    }
    if (!row && t.key.startsWith("csv.")) row = existing.find((e) => !used.has(e.id) && e.yahoo_team_key === null && norm(e.name) === norm(t.name));
    const wantedAbbr = (m.find((r) => r.abbreviation)?.abbreviation ?? "").toUpperCase();

    if (row) {
      used.add(row.id);
      ids.set(t.key, row.id);
      if (row.yahoo_team_key !== t.key) linked++;
      const clash = existing.some((e) => e.id !== row!.id && norm(e.name) === norm(name));
      if (clash) report.warnings.push(`Team "${row.name}" is "${name}" on Yahoo, but another team here has that name; not renamed.`);
      let abbr = row.abbreviation;
      if (wantedAbbr && wantedAbbr !== abbr) {
        if (TEAM_ABBREVIATION.test(wantedAbbr) && !taken.has(wantedAbbr)) {
          taken.delete(abbr);
          taken.add(wantedAbbr);
          abbr = wantedAbbr;
        } else report.warnings.push(`${name}: abbreviation "${wantedAbbr}" isn't valid or is taken; keeping ${abbr}.`);
      }
      await db.query(
        `UPDATE fantasy_teams SET name = $2, abbreviation = $3, waiver_priority = $4, yahoo_team_key = $5
          WHERE id = $1 AND (name, abbreviation, waiver_priority, yahoo_team_key) IS DISTINCT FROM ($2, $3, $4::int, $5)`,
        [row.id, clash ? row.name : name, abbr, t.waiverPriority, t.key],
      );
      continue;
    }
    const abbr = TEAM_ABBREVIATION.test(wantedAbbr) && !taken.has(wantedAbbr) ? wantedAbbr : Y.abbreviate(name, taken);
    if (wantedAbbr && abbr !== wantedAbbr) report.warnings.push(`${name}: abbreviation "${wantedAbbr}" isn't valid or is taken; using ${abbr}.`);
    taken.add(abbr);
    const { rows: [inserted] } = await db.query<{ id: number }>(
      `INSERT INTO fantasy_teams (league_id, name, abbreviation, waiver_priority, yahoo_team_key) VALUES ($1, $2, $3, $4, $5) RETURNING id::int`,
      [leagueId, name, abbr, t.waiverPriority, t.key],
    );
    ids.set(t.key, inserted.id);
    created++;
  }
  const orphans = existing.filter((e) => !used.has(e.id));
  if (orphans.length > 0) {
    report.warnings.push(`Not on Yahoo, kept as is: ${orphans.map((o) => o.name).join(", ")}. Rename them to their Yahoo names to link them, or replace the league.`);
  }
  if (created > 0 || linked > 0) report.notes.push(`Teams: ${created} created, ${linked} linked to their Yahoo team.`);
  return ids;
}

/** league_members from teams.csv: the listed emails, and nothing else. */
async function applyMembers(
  db: PoolClient, leagueId: number, snap: Y.ImportSnapshot, members: Record<string, string>[], teamIds: Map<string, number>, report: ApplyReport,
): Promise<{ all: Set<string>; unclaimed: number }> {
  let commissioner = false;
  const emails = new Set<string>();
  for (const r of members) {
    const id = teamIds.get(r.yahoo_team_key);
    if (id === undefined) {
      report.warnings.push(`teams.csv: no team ${r.yahoo_team_key} in the snapshot; row skipped.`);
      continue;
    }
    for (const email of r.email.split(/[;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)) {
      if (!/^[^\s@]+@[^\s@]+$/.test(email)) report.warnings.push(`teams.csv: "${email}" isn't an email; skipped.`);
      else if (emails.has(email)) report.warnings.push(`teams.csv: ${email} is listed twice; only its first team counts.`);
      else {
        emails.add(email);
        const isCommish = YES.has(r.commissioner.toLowerCase());
        commissioner ||= isCommish;
        await db.query(
          `INSERT INTO league_members (league_id, email, fantasy_team_id, is_commissioner) VALUES ($1, $2, $3, $4)
           ON CONFLICT (league_id, email) DO UPDATE SET fantasy_team_id = EXCLUDED.fantasy_team_id, is_commissioner = EXCLUDED.is_commissioner
            WHERE (league_members.fantasy_team_id, league_members.is_commissioner) IS DISTINCT FROM (EXCLUDED.fantasy_team_id, EXCLUDED.is_commissioner)`,
          [leagueId, email, id, isCommish],
        );
      }
    }
  }
  await db.query(`DELETE FROM league_members WHERE league_id = $1 AND NOT (email = ANY($2::text[]))`, [leagueId, [...emails]]);
  const unclaimed = snap.teams.filter((t) => !members.some((r) => r.yahoo_team_key === t.key && r.email.trim()));
  if (unclaimed.length > 0) report.warnings.push(`No email for ${unclaimed.map((t) => t.name).join(", ")}: nobody can sign in as ${unclaimed.length === 1 ? "that team" : "those teams"} yet.`);
  if (!commissioner) report.warnings.push("Nobody is marked commissioner in teams.csv, so nobody can change league settings.");
  return { all: emails, unclaimed: unclaimed.length };
}

/** Each week's pairings (replaced when they differ) and results (week_results, upserted). */
async function applyMatchups(
  db: PoolClient, leagueId: number, snap: Y.ImportSnapshot,
  ctx: { api: boolean; today: string; ourWeek: (w: number) => number; playoffStart: number | null; teamId: (k: string | null) => number | null },
  report: ApplyReport,
) {
  const { api, today, ourWeek, playoffStart, teamId } = ctx;
  const byWeek = new Map<number, Y.YahooMatchup[]>();
  for (const m of snap.matchups) byWeek.set(m.week, [...(byWeek.get(m.week) ?? []), m]);
  let pairs = 0;
  let changedWeeks = 0;
  let finals = 0;
  let live = 0;
  const scheduled = new Set<number>();
  for (const [yWeek, list] of byWeek) {
    const week = ourWeek(yWeek);
    const w = snap.weeks.find((x) => x.week === yWeek);
    const desired: { a: number; b: number; bracket: string | null; round: number | null; slot: number | null }[] = [];
    const slotCount = new Map<string, number>();
    const results: { team: number; line: unknown; final: boolean }[] = [];
    for (const m of list) {
      if (m.teams.length !== 2) continue;
      const bracket = api ? bracketOf(m) : null;
      if (!api && m.isPlayoffs) continue;
      const [a, b] = m.teams.map((t) => teamId(t.key));
      if (a === null || b === null) continue;
      const slot = bracket ? (slotCount.get(bracket) ?? 0) + 1 : null;
      if (bracket) slotCount.set(bracket, slot!);
      const round = bracket && playoffStart !== null ? week - playoffStart + 1 : null;
      desired.push({ a, b, bracket, round, slot });
      pairs++;
      if (!m.isPlayoffs) scheduled.add(week);
      const final = !!w && w.end < today;
      if (final && m.status !== "postevent") report.warnings.push(`Week ${week} has ended but Yahoo calls it "${m.status}"; its results may still change.`);
      const isLive = !final && api && (m.status === "midevent" || (!!w && w.start <= today));
      if (final || isLive) for (const [i, t] of m.teams.entries()) results.push({ team: i === 0 ? a : b, line: t.line, final });
      if (final) finals++;
      else if (isLive) live++;
    }
    if (desired.length > 0) {
      const { rows: have } = await db.query<{ a: number; b: number | null; bracket: string | null; round: number | null; slot: number | null }>(
        `SELECT team_a_id::int AS a, team_b_id::int AS b, bracket, bracket_round AS round, bracket_slot AS slot FROM matchups WHERE league_id = $1 AND week = $2`,
        [leagueId, week],
      );
      const sig = (x: { a: number; b: number | null; bracket: string | null; round: number | null; slot: number | null }) =>
        `${[x.a, x.b].sort((p, q) => (p ?? 0) - (q ?? 0)).join("-")}|${x.bracket}|${x.round}|${x.slot}`;
      if (have.map(sig).sort().join(";") !== desired.map(sig).sort().join(";")) {
        await db.query(`DELETE FROM matchups WHERE league_id = $1 AND week = $2`, [leagueId, week]);
        for (const d of desired) {
          await db.query(
            `INSERT INTO matchups (league_id, week, team_a_id, team_b_id, bracket, bracket_round, bracket_slot) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [leagueId, week, d.a, d.b, d.bracket, d.round, d.slot],
          );
        }
        changedWeeks++;
      }
    }
    for (const r of results) {
      await db.query(
        `INSERT INTO week_results (league_id, week, fantasy_team_id, line, final) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (league_id, week, fantasy_team_id) DO UPDATE SET line = EXCLUDED.line, final = EXCLUDED.final
          WHERE (week_results.line, week_results.final) IS DISTINCT FROM (EXCLUDED.line, EXCLUDED.final)`,
        [leagueId, week, r.team, JSON.stringify(r.line), r.final],
      );
    }
  }
  if (!api && byWeek.size > 0) {
    const missing = snap.weeks.map((w) => ourWeek(w.week)).filter((w) => (playoffStart === null || w < playoffStart) && !scheduled.has(w));
    if (missing.length > 0) report.warnings.push(`No matchups for regular-season week(s) ${missing.join(", ")}.`);
  }
  if (byWeek.size > 0) {
    report.notes.push(`Schedule: ${pairs} matchups over ${byWeek.size} weeks (${changedWeeks} weeks' pairings changed); ` +
      `${finals} finished with Yahoo's results${api ? `, ${live} live` : ""}.`);
  }
}

/** Today's rosters (roster_players) and every fetched day's lineups (lineup_slots), made to match Yahoo's. */
async function applyRosters(
  db: PoolClient, leagueId: number, snap: Y.ImportSnapshot, todayRosters: Map<string, Y.YahooRosterEntry[]>,
  ctx: { pid: (p: Y.YahooPlayer) => number | null; teamId: (k: string | null) => number | null; ilRules: IlRules; slots: Partial<Record<LineupSlot, number>> },
  report: ApplyReport,
) {
  const { pid, teamId, ilRules, slots } = ctx;
  const { warnings } = report;
  const ids = [...todayRosters.values()].flat().map((e) => pid(e.player)).filter((id): id is number => id !== null);
  const [{ rows: positions }, injuries] = await Promise.all([
    db.query<{ id: number; position: string | null; name: string }>(
      `SELECT id, nullif(position, '') AS position, first_name || ' ' || last_name AS name FROM players WHERE id = ANY($1)`, [ids],
    ),
    getInjuries(db, ids),
  ]);
  const info = new Map(positions.map((p) => [p.id, p]));
  const startDate = new Date(`${snap.league.startDate || snap.weeks[0]?.start}T00:00:00Z`);
  const todaySlots = new Map<number, Map<number, LineupSlot>>();
  const want = { player: [] as number[], team: [] as number[], slot: [] as string[] };
  for (const [key, entries] of todayRosters) {
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
      // Starters must fit our positions; IL players stay put, like Yahoo, and get flagged below.
      if (isStarting(slot) && !eligible.includes(slot)) {
        warnings.push(`${p?.name} (${p?.position ?? "no position"}) can't play ${slot} here (Yahoo: ${e.player.eligiblePositions.join(", ")}); Yahoo's lineup still counts, his standing slot is the bench.`);
        slot = "BN";
      }
      slotsToday.set(id, slot);
      check.push({ id, slot, eligible, name: p?.name ?? e.player.full });
      want.player.push(id);
      want.team.push(tid);
      want.slot.push(slot);
    }
    todaySlots.set(tid, slotsToday);
    for (const problem of rosterProblems(check, slots)) {
      warnings.push(`${snap.teams.find((t) => t.key === key)?.name}'s roster doesn't fit this league's slots here: ${problem}`);
    }
  }
  // Gone from every Yahoo roster: off ours. Moved or re-slotted: updated (acquired now, until transactions say when).
  await db.query(`DELETE FROM roster_players WHERE league_id = $1 AND NOT (player_id = ANY($2::int[]))`, [leagueId, want.player]);
  await db.query(
    `INSERT INTO roster_players (league_id, player_id, fantasy_team_id, slot, acquired_at)
     SELECT $1, p, t, s::lineup_slot, CASE WHEN EXISTS (SELECT 1 FROM transactions WHERE league_id = $1) THEN now() ELSE $5 END
       FROM unnest($2::int[], $3::bigint[], $4::text[]) AS x(p, t, s)
     ON CONFLICT (league_id, player_id) DO UPDATE SET
       fantasy_team_id = EXCLUDED.fantasy_team_id, slot = EXCLUDED.slot,
       acquired_at = CASE WHEN roster_players.fantasy_team_id = EXCLUDED.fantasy_team_id THEN roster_players.acquired_at ELSE EXCLUDED.acquired_at END
      WHERE (roster_players.fantasy_team_id, roster_players.slot) IS DISTINCT FROM (EXCLUDED.fantasy_team_id, EXCLUDED.slot)`,
    [leagueId, want.player, want.team, want.slot, startDate],
  );

  // --- Each fetched day's lineup, as Yahoo has it (including days set ahead) ---
  const rows = { team: [] as number[], date: [] as string[], player: [] as number[], slot: [] as string[] };
  const days = { team: [] as number[], date: [] as string[] };
  for (const [date, byTeam] of snap.rosters) {
    for (const [key, entries] of byTeam) {
      const tid = teamId(key);
      if (tid === null) continue;
      days.team.push(tid);
      days.date.push(date);
      for (const e of entries) {
        const id = pid(e.player);
        if (id === null) continue;
        if (date > snap.meta.today && !todaySlots.get(tid)?.has(id)) {
          warnings.push(`${e.player.full} is in ${key}'s ${date} lineup but not on that team today; skipped.`);
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
    `DELETE FROM lineup_slots ls USING unnest($2::bigint[], $3::date[]) AS d(t, day)
      WHERE ls.league_id = $1 AND ls.fantasy_team_id = d.t AND ls.date = d.day
        AND NOT EXISTS (SELECT 1 FROM unnest($4::bigint[], $5::date[], $6::int[]) AS k(t, day, p)
                         WHERE k.t = ls.fantasy_team_id AND k.day = ls.date AND k.p = ls.player_id)`,
    [leagueId, days.team, days.date, rows.team, rows.date, rows.player],
  );
  await db.query(
    `INSERT INTO lineup_slots (league_id, fantasy_team_id, date, player_id, slot)
     SELECT $1, t, d::date, p, s::lineup_slot FROM unnest($2::bigint[], $3::text[], $4::int[], $5::text[]) AS x(t, d, p, s)
     ON CONFLICT (fantasy_team_id, date, player_id) DO UPDATE SET slot = EXCLUDED.slot WHERE lineup_slots.slot IS DISTINCT FROM EXCLUDED.slot`,
    [leagueId, rows.team, rows.date, rows.player, rows.slot],
  );
  report.notes.push(`Rosters: ${want.player.length} players on ${todaySlots.size} teams; ${rows.team.length} daily lineup rows over ${snap.rosters.size} days.`);
}

/**
 * Yahoo's completed transactions, as if made here: the League page's history and
 * each player's, adds counted against the limits (countAdds), and roster_players.acquired_at.
 * Each is saved once (transactions.yahoo_key); one the CSV import saved first is
 * recognized by its team, type, players and time and given its Yahoo key.
 * A player dropped within the waiver period and not picked up since goes on waivers.
 * Failed waiver claims (CSV only) are saved as failed claims without a waiver run: they only show in
 * the League page's waiver reports and change nothing else.
 */
async function applyTransactions(
  db: PoolClient, snap: Y.ImportSnapshot, leagueId: number, teamId: (key: string | null) => number | null,
  pid: (p: Y.YahooPlayer) => number | null, ctx: { api: boolean; leagueTz: string; waiverDays: number; today: string },
  report: ApplyReport,
) {
  const { api, leagueTz, waiverDays, today } = ctx;
  if (snap.transactions.length === 0) {
    if (!api) report.notes.push("Transactions: none (no transactions.csv), so no history, add counts or players on waivers.");
    return;
  }
  const tz = snap.transactionsTimeZone ?? leagueTz;
  const { rowCount: known } = await db.query(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [tz]);
  if (!known) {
    report.errors.push(`league.json: transactionsTimeZone "${tz}" isn't a time zone (e.g. "America/Los_Angeles").`);
    return;
  }
  let saved = 0;
  let adopted = 0;
  let failed = 0;
  let moves = 0;
  for (const tx of snap.transactions) {
    const players = new Map<number, { from: number | null; to: number | null }>();
    for (const m of tx.moves) {
      const id = pid(m.player);
      if (id !== null) players.set(id, { from: teamId(m.from), to: teamId(m.to) });
    }
    if (players.size === 0) continue;
    const key = api ? tx.id : csvTransactionKey(tx);
    const { rowCount: have } = await db.query(`SELECT 1 FROM transactions WHERE league_id = $1 AND yahoo_key = $2`, [leagueId, key]);
    if (have) continue;
    if (api) {
      // Imported from the CSVs before the API was connected: the same team (either side of a trade), type and player moves within a day.
      const { rows: [same] } = await db.query<{ id: number }>(
        `SELECT t.id::int FROM transactions t
          WHERE t.league_id = $1 AND (t.yahoo_key IS NULL OR t.yahoo_key LIKE 'csv:%') AND t.status = 'completed'
            AND t.type = $2 AND (t.team_id IS NOT DISTINCT FROM $3 OR ($2 = 'trade' AND t.trade_team_id IS NOT DISTINCT FROM $3))
            AND abs(extract(epoch FROM t.created_at - ($4::timestamp AT TIME ZONE $5))) < 86400
            AND (SELECT array_agg(tp.player_id || ':' || coalesce(tp.from_team_id::text, '') || ':' || coalesce(tp.to_team_id::text, '') ORDER BY 1)
                   FROM transaction_players tp WHERE tp.transaction_id = t.id) = $6::text[]
          ORDER BY abs(extract(epoch FROM t.created_at - ($4::timestamp AT TIME ZONE $5))) LIMIT 1`,
        [leagueId, tx.type, teamId(tx.team), tx.at, tz,
          [...players].map(([p, { from, to }]) => `${p}:${from ?? ""}:${to ?? ""}`).sort()],
      );
      if (same) {
        await db.query(`UPDATE transactions SET yahoo_key = $2 WHERE id = $1`, [same.id, key]);
        adopted++;
        continue;
      }
    }
    const { rows: [row] } = await db.query<{ id: number; day: string }>(
      `INSERT INTO transactions (league_id, type, status, team_id, trade_team_id, faab_bid, created_at, processed_at, accepted_at, failure_reason, yahoo_key)
       SELECT $1, $2, CASE WHEN $9::text IS NULL THEN 'completed' ELSE 'failed' END, $3, $4, $5, x.at, x.at,
              CASE WHEN $2 = 'trade' THEN x.at END, nullif($9, ''), $10
         FROM (SELECT ($6::timestamp AT TIME ZONE $7) AS at) x
       RETURNING id::int, to_char((created_at AT TIME ZONE $8)::date, 'YYYY-MM-DD') AS day`,
      [leagueId, tx.type, teamId(tx.team), teamId(tx.tradeTeam), tx.type === "waiver_claim" ? tx.faabBid : null, tx.at, tz, leagueTz,
        tx.failureReason, key],
    );
    if (row.day > today) report.errors.push(`Transaction ${tx.id} (${tx.at}, ${tz}) is after today (${today})${api ? "" : "; rebuild the CSVs"}.`);
    for (const [player, { from, to }] of players) {
      await db.query(
        `INSERT INTO transaction_players (transaction_id, player_id, from_team_id, to_team_id) VALUES ($1, $2, $3, $4)`,
        [row.id, player, from, to],
      );
      if (tx.failureReason === null) moves++;
    }
    if (tx.failureReason === null) saved++;
    else failed++;
  }

  // Rostered players were acquired by their latest move to that team (else as set with the roster).
  const { rowCount: acquired } = await db.query(
    `UPDATE roster_players rp SET acquired_at = x.at
       FROM (SELECT DISTINCT ON (tp.player_id, tp.to_team_id) tp.player_id, tp.to_team_id, t.created_at AS at
               FROM transaction_players tp JOIN transactions t ON t.id = tp.transaction_id
              WHERE t.league_id = $1 AND t.status = 'completed' AND tp.to_team_id IS NOT NULL
              ORDER BY tp.player_id, tp.to_team_id, t.created_at DESC, t.id DESC) x
      WHERE rp.league_id = $1 AND rp.player_id = x.player_id AND rp.fantasy_team_id = x.to_team_id
        AND rp.acquired_at IS DISTINCT FROM x.at`,
    [leagueId],
  );
  // Waivers: cleared or picked up since, off; then, like a drop here (runRosterMove), on waivers until
  // the first waiver run at least waiver_days after the drop.
  await db.query(
    `DELETE FROM waiver_players w WHERE w.league_id = $1
        AND (w.clears_at <= now() OR EXISTS (SELECT 1 FROM roster_players rp WHERE rp.league_id = $1 AND rp.player_id = w.player_id))`,
    [leagueId],
  );
  const { rows: onWaivers } = waiverDays <= 0 ? { rows: [] } : await db.query<{ name: string; clears: string }>(
    `WITH last AS (
       SELECT DISTINCT ON (tp.player_id) tp.player_id, tp.from_team_id, tp.to_team_id, t.created_at AS at
         FROM transaction_players tp JOIN transactions t ON t.id = tp.transaction_id
        WHERE t.league_id = $1 AND t.status = 'completed'
        ORDER BY tp.player_id, t.created_at DESC, t.id DESC
     ), w AS (
       INSERT INTO waiver_players (league_id, player_id, clears_at, dropped_by_team_id)
       SELECT $1, l.player_id, next_waiver_run($1, l.at + make_interval(days => $2)), l.from_team_id
         FROM last l
        WHERE l.to_team_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM roster_players rp WHERE rp.league_id = $1 AND rp.player_id = l.player_id)
          AND next_waiver_run($1, l.at + make_interval(days => $2)) > now()
       ON CONFLICT (league_id, player_id) DO NOTHING
       RETURNING player_id, clears_at
     )
     SELECT p.first_name || ' ' || p.last_name AS name,
            to_char(w.clears_at AT TIME ZONE $3, 'Mon FMDD FMHH12:MI am') AS clears
       FROM w JOIN players p ON p.id = w.player_id ORDER BY w.clears_at, p.last_name`,
    [leagueId, waiverDays, leagueTz],
  );
  // A rostered player whose last move here isn't onto his team: the sources disagree.
  const { rows: mismatched } = await db.query<{ name: string }>(
    `SELECT p.first_name || ' ' || p.last_name AS name
       FROM roster_players rp JOIN players p ON p.id = rp.player_id
       JOIN LATERAL (SELECT tp.to_team_id FROM transaction_players tp JOIN transactions t ON t.id = tp.transaction_id
                      WHERE t.league_id = $1 AND t.status = 'completed' AND tp.player_id = rp.player_id
                      ORDER BY t.created_at DESC, t.id DESC LIMIT 1) last ON true
      WHERE rp.league_id = $1 AND last.to_team_id IS DISTINCT FROM rp.fantasy_team_id
      ORDER BY p.last_name`,
    [leagueId],
  );
  if (mismatched.length > 0) {
    report.warnings.push(api
      ? `Yahoo's transactions don't end with ${mismatched.map((m) => m.name).join(", ")} on the team Yahoo's roster has.`
      : `transactions.csv doesn't end with ${mismatched.map((m) => m.name).join(", ")} on the team rosters.csv has; check both are from today.`);
  }
  if (saved + adopted + failed > 0 || !api) {
    report.notes.push(`Transactions: ${saved} new (${moves} player moves, times in ${tz})${adopted ? `, ${adopted} matched to imported ones` : ""}` +
      `${api ? "" : `, ${failed} failed waiver claims`}; ${acquired} rostered players' acquired dates; ` +
      `${onWaivers.length} newly on waivers${onWaivers.length > 0 ? ` (${onWaivers.map((w) => `${w.name} until ${w.clears}`).join(", ")})` : ""}.`);
  }
}

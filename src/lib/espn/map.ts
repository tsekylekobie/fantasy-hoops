// ESPN JSON -> the provider-neutral types (src/lib/data/types.ts). Pure (tested in
// map.test.ts against data/samples/espn/). Ids come out as ours: teams through
// the fixed table below (BALLDONTLIE's ids), players and games through the
// lookups the client resolved against the database first (./ids.ts).

import type { Game, Injury, Player, StatLine, Team } from "../data/types";
import type {
  EspnBoxAthlete,
  EspnCompetitor,
  EspnEvent,
  EspnInjury,
  EspnRosterAthlete,
  EspnStatus,
  EspnSummaryResponse,
  EspnTeamRef,
} from "./raw";

/** The 30 teams by NBA abbreviation: our (BALLDONTLIE's) id, conference and division. */
export const NBA_TEAMS: Record<string, { id: number; conference: "East" | "West"; division: string }> = {
  ATL: { id: 1, conference: "East", division: "Southeast" },
  BOS: { id: 2, conference: "East", division: "Atlantic" },
  BKN: { id: 3, conference: "East", division: "Atlantic" },
  CHA: { id: 4, conference: "East", division: "Southeast" },
  CHI: { id: 5, conference: "East", division: "Central" },
  CLE: { id: 6, conference: "East", division: "Central" },
  DAL: { id: 7, conference: "West", division: "Southwest" },
  DEN: { id: 8, conference: "West", division: "Northwest" },
  DET: { id: 9, conference: "East", division: "Central" },
  GSW: { id: 10, conference: "West", division: "Pacific" },
  HOU: { id: 11, conference: "West", division: "Southwest" },
  IND: { id: 12, conference: "East", division: "Central" },
  LAC: { id: 13, conference: "West", division: "Pacific" },
  LAL: { id: 14, conference: "West", division: "Pacific" },
  MEM: { id: 15, conference: "West", division: "Southwest" },
  MIA: { id: 16, conference: "East", division: "Southeast" },
  MIL: { id: 17, conference: "East", division: "Central" },
  MIN: { id: 18, conference: "West", division: "Northwest" },
  NOP: { id: 19, conference: "West", division: "Southwest" },
  NYK: { id: 20, conference: "East", division: "Atlantic" },
  OKC: { id: 21, conference: "West", division: "Northwest" },
  ORL: { id: 22, conference: "East", division: "Southeast" },
  PHI: { id: 23, conference: "East", division: "Atlantic" },
  PHX: { id: 24, conference: "West", division: "Pacific" },
  POR: { id: 25, conference: "West", division: "Northwest" },
  SAC: { id: 26, conference: "West", division: "Pacific" },
  SAS: { id: 27, conference: "West", division: "Southwest" },
  TOR: { id: 28, conference: "East", division: "Atlantic" },
  UTA: { id: 29, conference: "West", division: "Northwest" },
  WAS: { id: 30, conference: "East", division: "Southeast" },
};

/** ESPN's abbreviations that differ from the NBA's (and ours). */
const ESPN_ABBR: Record<string, string> = { GS: "GSW", NY: "NYK", SA: "SAS", NO: "NOP", UTAH: "UTA", WSH: "WAS" };

export const nbaAbbr = (espn: string) => ESPN_ABBR[espn.toUpperCase()] ?? espn.toUpperCase();

/** Our team id for an ESPN team, or null (an All-Star or international team). */
export function ourTeamId(t: Pick<EspnTeamRef, "abbreviation"> | null | undefined): number | null {
  return t?.abbreviation ? (NBA_TEAMS[nbaAbbr(t.abbreviation)]?.id ?? null) : null;
}

/** ESPN's season year 2027 is the 2026-27 season, our season=2026. */
export const ourSeason = (espnYear: number) => espnYear - 1;
export const espnSeasonYear = (season: number) => season + 1;

/** ESPN's season types we store: regular season, postseason, play-in (not preseason or All-Star). */
const STORED_SEASON_TYPES = new Set([2, 3, 5]);

const blankToNull = (s: string | null | undefined) => (s == null || s.trim() === "" ? null : s.trim());
const int = (s: string | null | undefined): number | null => {
  const n = Number(String(s ?? "").replace(/^\+/, ""));
  return s != null && String(s).trim() !== "" && Number.isFinite(n) ? n : null;
};

export function toTeam(t: EspnTeamRef): Team | null {
  const abbr = nbaAbbr(t.abbreviation);
  const known = NBA_TEAMS[abbr];
  if (!known) return null;
  return {
    id: known.id,
    abbreviation: abbr,
    city: blankToNull(t.location),
    name: blankToNull(t.name),
    fullName: blankToNull(t.displayName),
    conference: known.conference,
    division: known.division,
    isCurrent: true,
    espnId: Number(t.id),
    raw: t,
  };
}

/** "Wendell Carter Jr." -> ["Wendell", "Carter Jr."]: ESPN's box scores and injuries only give the whole name sometimes. */
export function splitName(full: string): { firstName: string; lastName: string } {
  const s = full.trim().replace(/\s+/g, " ");
  const i = s.indexOf(" ");
  return i < 0 ? { firstName: s, lastName: "" } : { firstName: s.slice(0, i), lastName: s.slice(i + 1) };
}

/** A player as ESPN describes him, before he has our id. */
export interface EspnAthlete {
  espnId: number;
  firstName: string;
  lastName: string;
  position: string | null;
  jerseyNumber: string | null;
  /** Our team id, or null. */
  teamId: number | null;
}

export function rosterAthlete(a: EspnRosterAthlete, teamId: number | null): EspnAthlete {
  const names = a.firstName != null && a.lastName != null
    ? { firstName: a.firstName, lastName: a.lastName }
    : splitName(a.fullName ?? a.displayName ?? "");
  return {
    espnId: Number(a.id),
    ...names,
    position: blankToNull(a.position?.abbreviation),
    jerseyNumber: blankToNull(a.jersey),
    teamId,
  };
}

export function toPlayer(a: EspnAthlete, id: number, raw: unknown = null): Player {
  return {
    id,
    firstName: a.firstName,
    lastName: a.lastName,
    position: a.position,
    teamId: a.teamId,
    jerseyNumber: a.jerseyNumber,
    team: null,
    espnId: a.espnId,
    raw,
  };
}

/** yyyy-mm-dd in the NBA's time zone (US Eastern), where ESPN's scoreboard puts its dates. */
export function easternDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** "20261116" for "2026-11-16". */
export const ymd = (date: string) => date.replaceAll("-", "");
/** "2026-11-16" for 20261116 or "20261116". */
export const isoDate = (d: number | string) => {
  const s = String(d);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};

/**
 * Our status columns from ESPN's: status_state "scheduled" | "in_progress" |
 * "final" (as BALLDONTLIE's, which the app reads), time the live clock
 * ("Q3 7:23", "Halftime", "End Q1", "OT 2:10") or "Final".
 */
export function statusFields(s: EspnStatus): Pick<Game, "status" | "statusState" | "period" | "time" | "postponed"> {
  const name = s.type.name ?? "";
  const period = s.period && s.period > 0 ? s.period : null;
  const postponed = /POSTPONED|CANCELED|CANCELLED|SUSPENDED/.test(name);
  const status = blankToNull(s.type.description) ?? blankToNull(s.type.detail);
  if (postponed) return { status, statusState: "scheduled", period: null, time: null, postponed: true };
  if (s.type.state === "post") return { status: "Final", statusState: "final", period, time: "Final", postponed: false };
  if (s.type.state === "pre") return { status, statusState: "scheduled", period: null, time: null, postponed: false };
  const p = period ?? 1;
  const label = p <= 4 ? `Q${p}` : p === 5 ? "OT" : `${p - 4}OT`;
  const time = name === "STATUS_HALFTIME"
    ? "Halftime"
    : name === "STATUS_END_PERIOD"
      ? `End ${label}`
      : `${label} ${s.displayClock ?? ""}`.trim();
  return { status, statusState: "in_progress", period, time, postponed: false };
}

function score(c: EspnCompetitor | undefined): number | null {
  const v = c?.score;
  if (v == null) return null;
  return typeof v === "object" ? (v.value ?? int(v.displayValue)) : int(v);
}

/** The NBA Cup final doesn't count toward season stats; stored the way classifyGames reads it (raw.ist_stage). */
function isCupFinal(e: EspnEvent): boolean {
  const c = e.competitions[0];
  return c?.type?.abbreviation === "CC" || (c?.notes ?? []).some((n) => /NBA Cup Championship|NBA Cup Final/i.test(n.headline ?? ""));
}

/** Whether we store this event: a regular season, play-in or playoff game between two of the 30 teams. */
export function isStoredGame(e: EspnEvent): boolean {
  const type = e.seasonType?.type ?? e.season?.type;
  const c = e.competitions[0];
  if (!c || (type != null && !STORED_SEASON_TYPES.has(type))) return false;
  return c.competitors.length === 2 && c.competitors.every((x) => ourTeamId(x.team) !== null);
}

/** What we keep of an event in games.raw (the full event carries broadcasts, odds and headlines). */
function trimEvent(e: EspnEvent) {
  const c = e.competitions[0];
  return {
    id: e.id,
    date: e.date,
    name: e.name,
    season: e.season,
    seasonType: e.seasonType?.type ?? e.season?.type ?? null,
    type: c.type ?? null,
    notes: c.notes?.map((n) => n.headline) ?? [],
    status: c.status ?? e.status,
    competitors: c.competitors.map((x) => ({ id: x.id, homeAway: x.homeAway, abbreviation: x.team.abbreviation, score: x.score ?? null })),
    ist_stage: isCupFinal(e) ? "Championship" : null,
  };
}

/** Teams, date and season of an event, before it has our id. */
export interface EspnGameKey {
  espnId: number;
  date: string;
  season: number;
  homeTeamId: number;
  visitorTeamId: number;
}

/**
 * `date` is the US date the scoreboard was asked for when known: ESPN's event
 * date is UTC, so a 10:30 pm Eastern tip-off is dated the next day.
 */
export function gameKey(e: EspnEvent, date?: string): EspnGameKey {
  const c = e.competitions[0];
  const home = c.competitors.find((x) => x.homeAway === "home");
  const away = c.competitors.find((x) => x.homeAway === "away");
  return {
    espnId: Number(e.id),
    date: date ?? easternDate(c.date ?? e.date),
    season: ourSeason(e.season.year),
    homeTeamId: ourTeamId(home?.team)!,
    visitorTeamId: ourTeamId(away?.team)!,
  };
}

export function toGame(e: EspnEvent, id: number, date?: string): Game {
  const c = e.competitions[0];
  const key = gameKey(e, date);
  const st = statusFields(c.status ?? e.status!);
  const type = e.seasonType?.type ?? e.season.type;
  const scheduled = st.statusState === "scheduled";
  return {
    id,
    date: key.date,
    season: key.season,
    ...st,
    postseason: type === 3,
    datetime: new Date(c.date ?? e.date).toISOString(),
    homeTeamId: key.homeTeamId,
    visitorTeamId: key.visitorTeamId,
    homeTeamScore: scheduled ? null : score(c.competitors.find((x) => x.homeAway === "home")),
    visitorTeamScore: scheduled ? null : score(c.competitors.find((x) => x.homeAway === "away")),
    espnId: key.espnId,
    raw: trimEvent(e),
  };
}

/** "8-21" -> [8, 21]; anything else -> [0, 0]. */
export function madeAttempted(s: string | undefined): [number, number] {
  const m = /^(\d+)-(\d+)$/.exec(s?.trim() ?? "");
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

/** The athletes in a box score, for resolving their ids before toStatLines. */
/** ESPN's athlete id; null when a row has none (seen on DNP rows: only a short name). */
const athleteId = (a: EspnBoxAthlete): number | null => (/^\d+$/.test(String(a.athlete.id ?? "")) ? Number(a.athlete.id) : null);

export function boxAthletes(s: EspnSummaryResponse): EspnAthlete[] {
  return (s.boxscore.players ?? []).flatMap((t) =>
    (t.statistics[0]?.athletes ?? []).filter((a) => athleteId(a) !== null).map((a) => ({
      espnId: Number(a.athlete.id),
      ...splitName(a.athlete.displayName ?? ""),
      position: blankToNull(a.athlete.position?.abbreviation),
      jerseyNumber: blankToNull(a.athlete.jersey),
      teamId: ourTeamId(t.team),
    })),
  );
}

/**
 * One stat line per player in the box score, DNPs included (all zeros, min 0),
 * as BALLDONTLIE has them. ESPN gives whole minutes only.
 */
export function toStatLines(
  s: EspnSummaryResponse,
  ids: { gameId: number; players: Map<number, number> },
): StatLine[] {
  const comp = s.header.competitions[0];
  const event: EspnEvent = { id: s.header.id, date: comp.date, season: s.header.season, competitions: [comp] };
  const game = toGame(event, ids.gameId);
  const athletes = new Map(boxAthletes(s).map((a) => [a.espnId, a]));
  const out: StatLine[] = [];
  for (const t of s.boxscore.players ?? []) {
    const block = t.statistics[0];
    if (!block) continue;
    const teamId = ourTeamId(t.team);
    const at = (row: EspnBoxAthlete, label: string) => row.stats[block.labels.indexOf(label)];
    for (const row of block.athletes) {
      const espnId = athleteId(row);
      const playerId = espnId === null ? undefined : ids.players.get(espnId);
      if (espnId === null || playerId === undefined) continue;
      const n = (label: string) => int(at(row, label)) ?? 0;
      const [fgm, fga] = madeAttempted(at(row, "FG"));
      const [fg3m, fg3a] = madeAttempted(at(row, "3PT"));
      const [ftm, fta] = madeAttempted(at(row, "FT"));
      out.push({
        id: null,
        playerId,
        gameId: ids.gameId,
        teamId,
        season: game.season,
        postseason: game.postseason,
        min: n("MIN"),
        fgm, fga, fg3m, fg3a, ftm, fta,
        oreb: n("OREB"),
        dreb: n("DREB"),
        reb: n("REB"),
        ast: n("AST"),
        stl: n("STL"),
        blk: n("BLK"),
        turnover: n("TO"),
        pf: n("PF"),
        pts: n("PTS"),
        plusMinus: row.stats.length ? int(at(row, "+/-")) : null,
        player: toPlayer(athletes.get(espnId)!, playerId),
        team: toTeam(t.team),
        game,
        raw: { eventId: s.header.id, teamId: t.team.id, ...row, athlete: { id: row.athlete.id, displayName: row.athlete.displayName } },
      });
    }
  }
  return out;
}

/** The ESPN athlete id of an injury report entry: only its links carry it. */
export function injuryAthleteId(i: EspnInjury): number | null {
  for (const href of [...(i.athlete.links ?? []).map((l) => l.href), i.athlete.headshot?.href]) {
    const m = /\/id\/(\d+)(?:\/|$)/.exec(href ?? "") ?? /\/players\/full\/(\d+)\.png/.exec(href ?? "");
    if (m) return Number(m[1]);
  }
  return null;
}

export function injuryAthlete(i: EspnInjury): EspnAthlete | null {
  const espnId = injuryAthleteId(i);
  if (espnId === null) return null;
  const names = i.athlete.firstName != null && i.athlete.lastName != null
    ? { firstName: i.athlete.firstName, lastName: i.athlete.lastName }
    : splitName(i.athlete.displayName ?? "");
  return { espnId, ...names, position: blankToNull(i.athlete.position?.abbreviation), jerseyNumber: null, teamId: ourTeamId(i.athlete.team) };
}

/** "Right Hip Inflammation", "Left Foot Fracture", "Rest": side, body part and what's wrong. */
export function injuryName(d: EspnInjury["details"]): string | null {
  if (!d) return null;
  const detail = d.detail && !/^not specified$/i.test(d.detail) ? d.detail : null;
  const side = d.side && !/^not specified$/i.test(d.side) ? d.side : null;
  return [side, d.type, detail].filter(Boolean).join(" ") || null;
}

/**
 * ESPN's status as it comes ("Out", "Day-To-Day", "Suspension"): "Out" exactly,
 * so the default IL rule ({Out}) applies. The note is the short report and then
 * the longer one.
 */
export function toInjury(i: EspnInjury, playerId: number): Injury {
  const a = injuryAthlete(i)!;
  const note = [blankToNull(i.shortComment), blankToNull(i.longComment)].filter(Boolean).join(" ");
  return {
    playerId,
    player: toPlayer(a, playerId),
    status: i.status,
    returnDate: blankToNull(i.details?.returnDate)?.slice(0, 10) ?? null,
    description: note || null,
    injury: injuryName(i.details),
    raw: { ...i, athlete: { id: a.espnId, displayName: i.athlete.displayName, team: i.athlete.team?.abbreviation ?? null } },
  };
}

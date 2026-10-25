"use client";

// My team: the signed-in manager's daily lineup (docs/design/my-team.mockup.html).
// Pick a day, tap Move on a player, then tap a highlighted slot. Changes save
// right away. Past days and players whose game has tipped off are locked.
// The selected day lives in the URL (?date=yyyy-mm-dd; omitted for today).
import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Avatar from "@/components/Avatar";
import SiteHeader from "@/components/SiteHeader";
import { fetchJson, fmtAvg, fmtPct, fullName } from "@/components/players/format";
import type {
  AutoLineupRequest,
  AutoLineupResponse,
  LineupGame,
  LineupPlayer,
  LineupSlot,
  LineupUpdateRequest,
  TeamLineupResponse,
} from "@/lib/types";
import { LINEUP_SLOTS, STARTING_SLOTS } from "@/lib/types";
import styles from "./MyTeam.module.css";

/** One lineup spot. Slots with more players than the league allows get extra (overflow) spots. */
interface Spot {
  key: string;
  slot: LineupSlot;
  player: LineupPlayer | null;
}

function buildSpots(data: TeamLineupResponse): Spot[] {
  const bySlot = new Map<LineupSlot, LineupPlayer[]>();
  for (const p of data.players) bySlot.set(p.slot, [...(bySlot.get(p.slot) ?? []), p]);
  const spots: Spot[] = [];
  for (const slot of LINEUP_SLOTS) {
    const count = data.league.slots.find((s) => s.slot === slot)?.count ?? 0;
    const players = bySlot.get(slot) ?? [];
    for (let i = 0; i < Math.max(count, players.length); i++) {
      spots.push({ key: `${slot}-${i}`, slot, player: players[i] ?? null });
    }
  }
  return spots;
}

/** Whether the player in `from` can move to `to` (swapping with whoever is there). */
function canMove(from: Spot, to: Spot): boolean {
  const a = from.player;
  const b = to.player;
  if (!a || a.lock || from.key === to.key || from.slot === to.slot) return false;
  if (!a.eligible.includes(to.slot)) return false;
  return !b || (!b.lock && b.eligible.includes(from.slot));
}

const isStarter = (slot: LineupSlot) => STARTING_SLOTS.includes(slot);
const where = (slot: LineupSlot) => (slot === "BN" ? "the bench" : slot === "IL" || slot === "IL+" ? `the ${slot}` : slot);
const plays = (p: LineupPlayer) => p.game !== null && p.injuryStatus !== "Out";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  return { dow: WEEKDAYS[d.getUTCDay()], day: d.getUTCDate(), month: MONTHS[d.getUTCMonth()] };
}
/** "Sat 24" */
const shortDay = (iso: string) => `${parts(iso).dow} ${parts(iso).day}`;
/** "Sat, Oct 24" */
const longDay = (iso: string) => `${parts(iso).dow}, ${parts(iso).month} ${parts(iso).day}`;

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtTipoff(iso: string | null): string {
  if (!iso) return "TBD";
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function gameText(g: LineupGame): string {
  const opp = `${g.home ? "vs" : "@"} ${g.opponentAbbr}`;
  const score = g.teamScore !== null && g.opponentScore !== null ? `${g.teamScore}–${g.opponentScore}` : "";
  if (g.state === "scheduled") return `${opp} · ${fmtTipoff(g.tipoff)}`;
  if (g.state === "live") return `${opp} · ${g.statusText ?? "Live"}${score ? ` · ${score}` : ""}`;
  const result = g.teamScore !== null && g.opponentScore !== null && g.teamScore !== g.opponentScore
    ? (g.teamScore > g.opponentScore ? "W " : "L ") : "";
  return `${opp} · ${result}${score || "Final"}`;
}

/** Color class for a games-left pill: 4+ dark green, 3 green, 2 yellow, 1 red, 0 dark red. */
function gamesClass(remaining: number): string {
  return styles[`games${Math.min(remaining, 4)}`];
}

const LOCK_TEXT = { past: "Past days are locked", game: "Locked at tip-off", day: "Locked at the day's first tip-off" };

async function sendJson<T>(url: string, method: "PUT" | "POST", body: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !json) throw new Error(json?.error || `Request failed (${res.status}).`);
  return json;
}

type Note = { kind: "ok" | "error"; text: string } | null;

export default function MyTeam() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlDate = searchParams.get("date");

  const [data, setData] = useState<TeamLineupResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<Note>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoadError(null);
    setSelected(null);
    fetchJson<TeamLineupResponse>(`/api/team/lineup${urlDate ? `?date=${encodeURIComponent(urlDate)}` : ""}`, ctrl.signal)
      .then(setData)
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) setLoadError(err instanceof Error ? err.message : "Something went wrong");
      });
    return () => ctrl.abort();
  }, [urlDate, retryKey]);

  const pickDay = useCallback(
    (date: string, today: string) => {
      setNote(null);
      router.push(date === today ? pathname : `${pathname}?date=${date}`, { scroll: false });
    },
    [pathname, router],
  );

  // Escape cancels a move.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  if (!data) {
    return (
      <Shell>
        {loadError ? (
          <div className={`${styles.note} ${styles.error}`} role="alert">
            <p>{loadError}</p>
            {!loadError.startsWith("Sign in") && !loadError.startsWith("You don't") && (
              <button type="button" className={styles.btn} onClick={() => setRetryKey((k) => k + 1)}>Try again</button>
            )}
          </div>
        ) : (
          <p className={styles.loading}>Loading your team…</p>
        )}
      </Shell>
    );
  }

  const editable = data.date >= data.today;
  const spots = buildSpots(data);
  const sel = spots.find((s) => s.key === selected) ?? null;
  const starters = spots.filter((s) => isStarter(s.slot));
  const bench = spots.filter((s) => s.slot === "BN");
  const injured = spots.filter((s) => s.slot === "IL" || s.slot === "IL+");
  const playing = starters.filter((s) => s.player && plays(s.player)).length;
  const isToday = data.date === data.today;
  const dayName = isToday ? "today" : longDay(data.date);
  const idleFixable =
    editable &&
    starters.some((s) => !s.player || (!s.player.lock && !plays(s.player))) &&
    bench.some((s) => s.player && !s.player.lock && plays(s.player));

  async function save(next: TeamLineupResponse, message: string) {
    if (!data) return;
    const before = data;
    setData(next); // optimistic
    setSelected(null);
    setSaving(true);
    try {
      const req: LineupUpdateRequest = {
        date: next.date,
        slots: next.players.map((p) => ({ playerId: p.id, slot: p.slot })),
      };
      setData(await sendJson<TeamLineupResponse>("/api/team/lineup", "PUT", req));
      setNote({ kind: "ok", text: `${message} Lineup saved.` });
    } catch (err) {
      setData(before);
      setNote({ kind: "error", text: err instanceof Error ? err.message : "Couldn't save the lineup." });
    } finally {
      setSaving(false);
    }
  }

  function tap(spot: Spot) {
    if (saving || !data) return;
    if (!sel) {
      if (spot.player && !spot.player.lock && editable) {
        setSelected(spot.key);
        setNote(null);
      }
      return;
    }
    if (spot.key === sel.key) return setSelected(null);
    if (!canMove(sel, spot)) return;
    const a = sel.player!;
    const b = spot.player;
    const players = data.players.map((p) =>
      p.id === a.id ? { ...p, slot: spot.slot } : b && p.id === b.id ? { ...p, slot: sel.slot } : p,
    );
    const msg = `${fullName(a)} moved to ${where(spot.slot)}.${b ? ` ${fullName(b)} moved to ${where(sel.slot)}.` : ""}`;
    void save({ ...data, players }, msg);
  }

  async function autoSet(scope: AutoLineupRequest["scope"]) {
    if (!data) return;
    setSaving(true);
    setSelected(null);
    try {
      const req: AutoLineupRequest = { date: data.date, scope };
      const res = await sendJson<AutoLineupResponse>("/api/team/lineup/auto", "POST", req);
      const { changed, ...lineup } = res;
      setData(lineup);
      const days = changed.map((d) => (d === data.today ? "today" : shortDay(d)));
      setNote({
        kind: "ok",
        text: changed.length === 0
          ? `Your lineup was already the best one ${scope === "day" ? `for ${dayName}` : "for the rest of the week"}.`
          : `Best lineup set for ${days.length > 1 ? `${days.slice(0, -1).join(", ")} and ${days.at(-1)}` : days[0]}.`,
      });
    } catch (err) {
      setNote({ kind: "error", text: err instanceof Error ? err.message : "Couldn't set the lineup." });
    } finally {
      setSaving(false);
    }
  }

  function row(spot: Spot) {
    const p = spot.player;
    let mode: "idle" | "sel" | "target" | "off" = "idle";
    if (sel) mode = spot.key === sel.key ? "sel" : canMove(sel, spot) ? "target" : "off";
    const label = mode === "sel" ? "Cancel" : mode === "target" ? "Move here" : p?.lock ? "Locked" : p ? "Move" : "";
    const disabled = saving || mode === "off" || (mode === "idle" && (!p || !!p.lock || !editable));
    const noGame = p && !p.game;
    const gameCls = noGame && isStarter(spot.slot) ? styles.noGame : p?.game?.state === "live" ? styles.live : "";
    const stats = p?.season;
    return (
      <div key={spot.key} className={`${styles.grid} ${styles.row} ${styles[mode]}`}>
        <span><span className={styles.slot}>{spot.slot}</span></span>
        <span className={styles.player}>
          {p ? (
            <>
              <Avatar player={p} size={38} />
              <span className={styles.who}>
                <span className={styles.name}>
                  {fullName(p)}
                  {p.injuryStatus && (
                    <span className={`${styles.status} ${p.injuryStatus === "Out" ? styles.out : styles.dtd}`}>{p.injuryStatus}</span>
                  )}
                </span>
                <span className={styles.meta}>
                  {[p.teamAbbr, p.position?.replace(/-/g, "/")].filter(Boolean).join(" · ") || "Free agent"}
                  <span className={`${styles.gameInline} ${gameCls}`}> · {p.game ? gameText(p.game) : "No game"}</span>
                </span>
              </span>
            </>
          ) : (
            <>
              <span className={styles.emptyAvatar} aria-hidden="true" />
              <span className={styles.emptyName}>Empty</span>
            </>
          )}
        </span>
        <span className={`${styles.game} ${gameCls}`}>{p ? (p.game ? gameText(p.game) : "No game") : ""}</span>
        <span className={styles.weekCell}>
          {p && (
            <span
              className={`${styles.games} ${gamesClass(p.weekGames.remaining)}`}
              title={`${p.weekGames.remaining} game${p.weekGames.remaining === 1 ? "" : "s"} left of ${p.weekGames.total} this week`}
            >
              {p.weekGames.remaining}/{p.weekGames.total}
            </span>
          )}
        </span>
        {stats
          ? [fmtAvg(stats.min), fmtPct(stats.fgPct), fmtPct(stats.ftPct), fmtAvg(stats.fg3m), fmtAvg(stats.pts),
             fmtAvg(stats.reb), fmtAvg(stats.ast), fmtAvg(stats.stl), fmtAvg(stats.blk), fmtAvg(stats.tov)]
              .map((v, i) => <span key={i} className={styles.num}>{v}</span>)
          : Array.from({ length: 10 }, (_, i) => <span key={i} className={styles.num}>{p ? "—" : ""}</span>)}
        <span>
          {label && (
            <button
              type="button"
              className={`${styles.moveBtn} ${mode === "target" ? styles.go : mode === "sel" ? styles.cancel : ""}`}
              disabled={disabled}
              title={p?.lock ? LOCK_TEXT[p.lock] : undefined}
              aria-label={`${label} ${p ? fullName(p) : `empty ${spot.slot} slot`}`}
              onClick={() => tap(spot)}
            >
              {label}
            </button>
          )}
        </span>
      </div>
    );
  }

  const weekLabel = data.week ? `${data.week.isPlayoffs ? "Playoffs · " : ""}Week ${data.week.week}` : "Off week";
  const totalStarters = starters.length;

  return (
    <Shell>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>{data.team.name}</h1>
          <p className={styles.sub}>
            {weekLabel} · {data.league.name}
            {data.team.waiverPriority !== null && ` · Waiver priority ${data.team.waiverPriority}`}
          </p>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.btn} disabled={!editable || saving} onClick={() => autoSet("week")}>
            Auto set rest of week
          </button>
          <button type="button" className={`${styles.btn} ${styles.primary}`} disabled={!editable || saving} onClick={() => autoSet("day")}>
            Auto set {isToday ? "today" : shortDay(data.date)}
          </button>
        </div>
      </div>

      <div className={styles.summary}>
        <div className={styles.summaryCard}>
          <small>Starters playing {isToday ? "today" : shortDay(data.date)}</small>
          <b>{playing} of {totalStarters}</b>
          <span>
            {playing === totalStarters
              ? "Every starter has a game"
              : `${totalStarters - playing} starting slot${totalStarters - playing > 1 ? "s" : ""} won't score`}
          </span>
        </div>
        <div className={styles.summaryCard}>
          <small>Lineup lock</small>
          <b>{data.league.lineupLock === "game_time" ? "Tip-off" : "First game"}</b>
          <span>
            {data.league.lineupLock === "game_time"
              ? "Each player locks when his game starts"
              : "The whole lineup locks at the day's first tip-off"}
          </span>
        </div>
      </div>

      <div className={styles.days} role="group" aria-label="Lineup day">
        <span className={styles.daysLabel}>Lineup</span>
        <button type="button" className={styles.weekNav} aria-label="Previous week" onClick={() => pickDay(addDays(data.days[0].date, -1), data.today)}>
          ‹
        </button>
        {data.days.map((d) => (
          <button
            key={d.date}
            type="button"
            className={`${styles.day} ${d.date === data.date ? styles.dayOn : ""} ${d.date < data.today ? styles.dayPast : ""}`}
            aria-pressed={d.date === data.date}
            onClick={() => pickDay(d.date, data.today)}
          >
            {d.date === data.today ? "Today" : shortDay(d.date)}
            <small>{d.date === data.today ? shortDay(d.date) : `${d.nbaGames} game${d.nbaGames === 1 ? "" : "s"}`}</small>
          </button>
        ))}
        <button type="button" className={styles.weekNav} aria-label="Next week" onClick={() => pickDay(addDays(data.days.at(-1)!.date, 1), data.today)}>
          ›
        </button>
      </div>

      {note && (
        <div className={`${styles.note} ${note.kind === "ok" ? styles.ok : styles.error}`} role={note.kind === "ok" ? "status" : "alert"}>
          <p>{note.text}</p>
        </div>
      )}
      {!editable && (
        <div className={`${styles.note} ${styles.info}`}>
          <p>{longDay(data.date)} is in the past, so this lineup is locked.</p>
        </div>
      )}
      {sel?.player && (
        <div className={`${styles.note} ${styles.moving}`}>
          <p>
            Moving <b>{fullName(sel.player)}</b>. Pick a highlighted slot. Greyed-out slots aren&apos;t open to him
            (wrong position, or a locked player).
          </p>
          <button type="button" className={styles.btn} onClick={() => setSelected(null)}>Cancel</button>
        </div>
      )}
      {!sel && idleFixable && (
        <div className={`${styles.note} ${styles.tip}`}>
          <p>Some starting slots won&apos;t score {dayName}, and bench players with a game could fill them.</p>
          <button type="button" className={`${styles.btn} ${styles.primary}`} disabled={saving} onClick={() => autoSet("day")}>
            Auto set
          </button>
        </div>
      )}

      <div className={styles.table}>
        <div className={`${styles.grid} ${styles.header}`}>
          <span>Slot</span><span>Player</span><span className={styles.game}>{isToday ? "Today" : shortDay(data.date)}</span>
          <span className={styles.weekCell} title="Games left / games this week">Week</span>
          {["MIN", "FG%", "FT%", "3PM", "PTS", "REB", "AST", "STL", "BLK", "TO"].map((h) => (
            <span key={h} className={styles.num}>{h}</span>
          ))}
          <span />
        </div>
        <Group label="Starters" hint={`${playing} of ${totalStarters} have a game`} />
        {starters.map(row)}
        <Group label="Bench" hint="Stats count only from starting slots" />
        {bench.map(row)}
        {injured.length > 0 && (
          <>
            <Group label="Injured list" hint="Frees a roster spot · eligibility is a league setting" />
            {injured.map(row)}
          </>
        )}
      </div>
      <p className={styles.foot}>
        Season per-game averages. Changes save right away. A change carries forward to later days
        until a day you set separately.
      </p>
    </Shell>
  );
}

function Group({ label, hint }: { label: string; hint: string }) {
  return (
    <div className={styles.group}>
      {label}
      <span>{hint}</span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <SiteHeader />
        {children}
      </div>
    </div>
  );
}

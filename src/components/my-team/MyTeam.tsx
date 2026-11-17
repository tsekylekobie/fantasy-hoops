"use client";

// My team: the signed-in manager's daily lineup (docs/design/my-team.mockup.html),
// read-only: lineups, adds and drops happen on Yahoo, and the Yahoo sync stores them.
// Pick a day to see who was where. Stats are the day's box score, and the
// starters' total is what counts toward the matchup.
// Game limits (when the week has them): games used against the total and each
// capped slot, warning before starts that won't count (GameLimits.tsx).
// The selected day lives in the URL (?date=yyyy-mm-dd; omitted for today).
// While today's games are live, today's lineup refetches every minute and changed
// stats flash, counts show the change ("+1") and game statuses flash
// (components/live); a countdown by the week label shows the next update (pinned
// to the top of the screen once scrolled off).
// /team/[id] shows another manager's team with the same layout.
import YahooRefresh from "@/components/yahoo/YahooRefresh";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Avatar from "@/components/Avatar";
import SiteHeader from "@/components/SiteHeader";
import TeamBadge from "@/components/TeamBadge";
import PlayerModalHost, { PlayerButton } from "@/components/players/PlayerModalHost";
import ScrollName from "@/components/players/ScrollName";
import GameLimits from "./GameLimits";
import Flash from "@/components/live/Flash";
import { countDelta, shotsDelta } from "@/components/live/flashDelta";
import LiveCountdown from "@/components/live/LiveCountdown";
import { useLivePoll } from "@/components/live/useLivePoll";
import { fetchJson, fmtGameStatus, fmtInjuryStatus, fmtPct, fullName, todayIn } from "@/components/players/format";
import { activeRosterLimit, isIlSlot } from "@/lib/lineup/rules";
import type { CategoryLine, LineupGame, LineupPlayer, LineupSlot, TeamLineupResponse } from "@/lib/types";
import { LINEUP_SLOTS, STARTING_SLOTS } from "@/lib/types";
import styles from "./MyTeam.module.css";

/** One lineup spot. Slots with more players than the league lists get extra spots. */
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

/** Players outside IL, and how many the league allows. */
function activeCount(data: TeamLineupResponse) {
  const limit = activeRosterLimit(Object.fromEntries(data.league.slots.map((s) => [s.slot, s.count])));
  return { count: data.players.filter((p) => !isIlSlot(p.slot)).length, limit };
}

const isStarter = (slot: LineupSlot) => STARTING_SLOTS.includes(slot);

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
  if (g.state === "live") return `${opp} · ${g.statusText ? fmtGameStatus(g.statusText) : "Live"}${score ? ` · ${score}` : ""}`;
  const result = g.teamScore !== null && g.opponentScore !== null && g.teamScore !== g.opponentScore
    ? (g.teamScore > g.opponentScore ? "W " : "L ") : "";
  return `${opp} · ${result}${score || "Final"}`;
}

/** Color class for a games-left pill: 4+ dark green, 3 green, 2 yellow, 1 red, 0 dark red. */
function gamesClass(remaining: number): string {
  return styles[`games${Math.min(remaining, 4)}`];
}

/** Summed day lines; FG%/FT% from summed makes / attempts. */
function sumLines(lines: CategoryLine[]): CategoryLine {
  const t = { fgm: 0, fga: 0, ftm: 0, fta: 0, fg3m: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0 };
  for (const l of lines) for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += l[k];
  const pct = (m: number, a: number) => (a > 0 ? m / a : null);
  return { ...t, fgPct: pct(t.fgm, t.fga), ftPct: pct(t.ftm, t.fta) };
}

/**
 * The ten stat cells: MIN, FG%, FT%, then the counting stats. Percentages show
 * makes/attempts below. Cells flash when a live update changes them; `scope`
 * is whose line it is (see Flash).
 */
function statCells(line: CategoryLine | null, min: number | null, dnp: boolean, scope: string) {
  if (dnp) return [<span key="min" className={`${styles.num} ${styles.dnp}`}>DNP</span>, ...blankCells(9)];
  if (!line) return blankCells(10);
  const shooting = (p: number | null, m: number, a: number, k: string) => (
    <Flash key={k} className={styles.num} value={`${m}/${a}`} scope={scope} delta={shotsDelta(m, a)}>
      {fmtPct(p)}
      <small className={styles.shots}>{m}/{a}</small>
    </Flash>
  );
  return [
    // Minutes tick up all game, so they don't flash.
    <span key="min" className={styles.num}>{min === null ? "" : Math.round(min)}</span>,
    shooting(line.fgPct, line.fgm, line.fga, "fg"),
    shooting(line.ftPct, line.ftm, line.fta, "ft"),
    ...([line.fg3m, line.pts, line.reb, line.ast, line.stl, line.blk, line.tov] as number[]).map((v, i) => (
      // The last one is TO: lower is better.
      <Flash key={i} className={styles.num} value={v} scope={scope} delta={countDelta(v, i === 6)}>{v}</Flash>
    )),
  ];
}

const blankCells = (n: number) => Array.from({ length: n }, (_, i) => <span key={`b${i}`} className={styles.num} />);


/** With `teamId`, another manager's team (/team/[id]); without, the signed-in manager's. */
export default function MyTeam({ teamId }: { teamId?: number } = {}) {
  const other = teamId !== undefined;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlDate = searchParams.get("date");

  const [data, setData] = useState<TeamLineupResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoadError(null);
    const base = other ? `/api/teams/${teamId}/lineup` : "/api/team/lineup";
    fetchJson<TeamLineupResponse>(`${base}${urlDate ? `?date=${encodeURIComponent(urlDate)}` : ""}`, ctrl.signal)
      .then(setData)
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) setLoadError(err instanceof Error ? err.message : "Something went wrong");
      });
    return () => ctrl.abort();
  }, [urlDate, retryKey, other, teamId]);

  // Live stats: refetch today's lineup quietly.
  const [refreshing, setRefreshing] = useState(false);
  const polling = !!data && data.live && data.date === data.today;
  const nextPoll = useLivePoll(polling, () => {
    const base = other ? `/api/teams/${teamId}/lineup` : "/api/team/lineup";
    setRefreshing(true);
    fetchJson<TeamLineupResponse>(`${base}${urlDate ? `?date=${encodeURIComponent(urlDate)}` : ""}`)
      .then((next) => setData((d) => (d && d.date === next.date ? next : d)))
      .catch(() => {}) // the next poll tries again
      .finally(() => setRefreshing(false));
  });

  const pickDay = useCallback(
    (date: string, today: string) => {
      router.push(date === today ? pathname : `${pathname}?date=${date}`, { scroll: false });
    },
    [pathname, router],
  );

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
          <p className={styles.loading}>Loading {other ? "the" : "your"} team…</p>
        )}
      </Shell>
    );
  }

  const spots = buildSpots(data);
  const starters = spots.filter((s) => isStarter(s.slot));
  const bench = spots.filter((s) => s.slot === "BN");
  const injured = spots.filter((s) => isIlSlot(s.slot));
  const active = activeCount(data);
  const isToday = data.date === data.today;
  const starterLines = starters.flatMap((s) => (s.player?.dayStats ? [s.player.dayStats] : []));
  const totals = sumLines(starterLines);
  // Who the total is from: a lineup change on Yahoo changes it without a live update.
  const starterIds = starters.map((s) => s.player?.id ?? "").join(",");
  const date = data.date;

  function row(spot: Spot) {
    const p = spot.player;
    const noGame = p && !p.game;
    const gameCls = noGame && isStarter(spot.slot) ? styles.noGame : p?.game?.state === "live" ? styles.live : "";
    const day = p?.dayStats ?? null;
    // A starter whose game is on right now, unless he's listed Out and hasn't played
    // (the report can be stale, minutes aren't).
    const liveRow = p?.game?.state === "live" && isStarter(spot.slot) && (p.injury?.status !== "Out" || (day?.min ?? 0) > 0);
    // Final game but no minutes (or no stat row at all, e.g. listed Out).
    const dnp = p?.game?.state === "final" && (day === null || day.min === 0);
    return (
      <div
        key={spot.key}
        className={`${styles.grid} ${styles.row} ${liveRow ? styles.liveRow : ""}`}
      >
        <span>
          <span className={styles.slot} aria-label={p ? `${spot.slot}: ${fullName(p)}` : `Empty ${spot.slot} slot`}>
            {spot.slot}
          </span>
        </span>
        <span className={styles.player}>
          {p ? (
            <PlayerButton playerId={p.id}>
              <span className={styles.headshot}><Avatar player={p} size={38} /></span>
              <span className={styles.who}>
                <span className={styles.name} data-player-name>
                  <ScrollName firstName={p.firstName} lastName={p.lastName} />
                  {p.injury && (
                    <span className={`${styles.status} ${p.injury.status === "Out" ? styles.out : styles.dtd}`}>{fmtInjuryStatus(p.injury, todayIn())}</span>
                  )}
                </span>
                <span className={styles.meta}>
                  {[p.teamAbbr, p.position?.replace(/-/g, "/")].filter(Boolean).join(" · ") || "Free agent"}
                  <Flash className={`${styles.gameInline} ${gameCls}`} value={p.game ? gameText(p.game) : null} scope={`${date}:${p.id}`}>
                    {" · "}{p.game ? gameText(p.game) : "No game"}
                  </Flash>
                </span>
              </span>
            </PlayerButton>
          ) : (
            <>
              <span className={styles.emptyAvatar} aria-hidden="true" />
              <span className={styles.emptyName}>Empty</span>
            </>
          )}
        </span>
        <Flash className={`${styles.game} ${gameCls}`} value={p?.game ? gameText(p.game) : null} scope={p ? `${date}:${p.id}` : ""}>
          {p ? (p.game ? gameText(p.game) : "No game") : ""}
        </Flash>
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
        {statCells(day, day?.min ?? null, dnp, p ? `${date}:${p.id}` : "")}
      </div>
    );
  }

  return (
    <Shell>
      <div className={styles.head}>
        <div className={styles.ident}>
          <TeamBadge className={styles.badge} team={data.team} />
          <div className={styles.identText}>
            <h1 className={styles.title}>{data.team.name}</h1>
            {data.team.managerName && <p className={styles.manager}>{data.team.managerName}</p>}
            <YahooRefresh />
          </div>
        </div>
        {other && (
          <div className={styles.actions}>
            <Link className={styles.btn} href="/league">League standings</Link>
            <Link className={`${styles.btn} ${styles.primary}`} href={`/matchup?team=${data.team.id}`}>This week’s matchup</Link>
          </div>
        )}
      </div>

      <div className={styles.days} role="group" aria-label="Lineup day">
        <span className={styles.daysLabel}>
          {data.week ? `${data.week.isPlayoffs ? "Playoffs · " : ""}Week ${data.week.week}` : "Off week"}
          {polling && <span className={styles.countdown}><LiveCountdown nextAt={nextPoll} pending={refreshing} pin /></span>}
        </span>
        <button type="button" className={styles.weekNav} aria-label="Previous week" onClick={() => pickDay(addDays(data.days[0].date, -1), data.today)}>
          ‹
        </button>
        {data.days.map((d) => (
          <button
            key={d.date}
            type="button"
            className={`${styles.day} ${d.date === data.date ? styles.dayOn : ""} ${d.date < data.today ? styles.dayPast : ""} ${d.date === data.today ? styles.dayToday : ""}`}
            aria-pressed={d.date === data.date}
            aria-label={d.date === data.today ? `Today, ${longDay(d.date)}` : longDay(d.date)}
            onClick={() => pickDay(d.date, data.today)}
          >
            {shortDay(d.date)}
          </button>
        ))}
        <button type="button" className={styles.weekNav} aria-label="Next week" onClick={() => pickDay(addDays(data.days.at(-1)!.date, 1), data.today)}>
          ›
        </button>
      </div>

      {data.gameLimits && <GameLimits usage={data.gameLimits} week={data.week?.week ?? null} />}

      {/* Scrolled sideways (phones), names shorten and headshots drop out (ScrollName, as on Players). */}
      <div className={styles.table} onScroll={(e) => e.currentTarget.toggleAttribute("data-scrolled", e.currentTarget.scrollLeft > 2)}>
        <div className={`${styles.grid} ${styles.header}`}>
          <span>Slot</span><span>Player</span><span className={styles.game}>{isToday ? "Today" : shortDay(data.date)}</span>
          <span className={styles.weekCell}>
            <abbr className={styles.abbr} title="Games Remaining">Gms Rem</abbr>
          </span>
          {["MIN", "FG%", "FT%", "3PM", "PTS", "REB", "AST", "STL", "BLK", "TO"].map((h) => (
            <span key={h} className={styles.num}>{h}</span>
          ))}
        </div>
        <Group label="Starters" hint={`Only starters count toward ${other ? "the" : "your"} matchup`} />
        {starters.map(row)}
        <div className={`${styles.grid} ${styles.row} ${styles.totalRow}`}>
          <span />
          <span className={styles.totalLabel}>
            Starters total
            <span className={styles.totalLabelGame}>{isToday ? "today" : shortDay(data.date)}</span>
          </span>
          <span className={styles.game} />
          <span className={styles.weekCell} />
          {statCells(starterLines.length > 0 ? totals : null, null, false, `${date}:${starterIds}`)}
        </div>
        <Group label="Bench" hint="Stats count only from starting slots" />
        {bench.map(row)}
        {injured.length > 0 && (
          <>
            <Group
              label="Injured list"
              hint={`Doesn't count toward the ${active.limit}-player limit · ${data.league.ilRules.map((r) => `${r.slot}: ${r.text}`).join(" · ")}`}
            />
            {injured.map(row)}
          </>
        )}
      </div>
      <p className={styles.foot}>
        Stats are each player&apos;s box score for the day; they fill in as games are played.
        Lineups are set on Yahoo and show here once the sync picks them up.
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
        <PlayerModalHost>{children}</PlayerModalHost>
      </div>
    </div>
  );
}

"use client";

// The /box-scores page: the Box scores artboard in the Fantasy Hoops design
// canvas. A date's scoreboard, then each game's box score. Every stat cell is
// shaded by where it ranks among all players who played that date (queries/boxScores.ts).
// Clicking a game scrolls to its box score (every game stays listed). Once the
// scoreboard scrolls off, a compact copy pins to the top of the page and marks the
// game you're reading; the tables' pinned headers sit just under it.
// Keyed by date and ?game (page.tsx): ?game jumps to that game on load.
// Signed out there's no Owner column and no Add/Claim (league data is private).
// While games are live the page refreshes every 30s (useLiveRefresh; the countdown
// floats at the top once scrolled off, then sits in the pinned bar): changed stats,
// scores and statuses flash, counts show the change ("+1") and ranks the move
// ("▲3") for a moment (Flash), and rows reordered by Value slide into place (useFlipRows).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BoxRank, BoxRankKey, BoxScoreGame, BoxScorePlayer, BoxScoresResponse, BoxScoreTeam, RankTier } from "@/lib/types";
import SiteHeader from "@/components/SiteHeader";
import { useSignedIn } from "@/components/SessionProvider";
import PlayerModalHost, { PlayerButton } from "@/components/players/PlayerModalHost";
import AddDropSheet from "@/components/transactions/AddDropSheet";
import { useLiveRefresh } from "@/components/live/LiveRefresh";
import LiveCountdown from "@/components/live/LiveCountdown";
import Flash, { countDelta as count, shotsDelta, type FlashDelta } from "@/components/live/Flash";
import { useFlipRows } from "@/components/live/useFlipRows";
import StickyHeadTable from "@/components/table/StickyHeadTable";
import ScrollName from "@/components/players/ScrollName";
import { fmtGameDate, fmtGameStatus, fmtPct, fmtValue, fullName, waiverTooltip } from "@/components/players/format";
import TeamLink from "@/components/TeamLink";
import styles from "./BoxScoresView.module.css";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekday = (iso: string) => WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const href = (date: string) => `/box-scores?date=${date}`;
const boxId = (gameId: number) => `game-${gameId}`;
/** The compact bar's height in px; matches `--gbar-h` in the CSS. */
const BAR_H = 60;

function jumpTo(gameId: number, smooth = true) {
  const el = document.getElementById(boxId(gameId));
  if (!el) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: smooth && !reduce ? "smooth" : "auto", block: "start" });
}

/** Once the full scoreboard has scrolled off, show the pinned bar and track which game is being read. */
function usePinnedBar(games: BoxScoreGame[]) {
  const sbRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const sb = sbRef.current;
    if (!sb) return;
    const io = new IntersectionObserver(([e]) => setPinned(!e.isIntersecting && e.boundingClientRect.top < 0));
    io.observe(sb);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    let frame = 0;
    const spy = () => {
      frame = 0;
      // The last game whose box starts above the bar's bottom edge (plus some slack).
      let current: number | null = null;
      for (const g of games) {
        const el = document.getElementById(boxId(g.id));
        if (el && el.getBoundingClientRect().top <= BAR_H + 24) current = g.id;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(spy);
    };
    spy();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [games]);

  return { sbRef, pinned, active };
}

const LABELS: Record<BoxRankKey, string> = {
  pts: "PTS", fg3m: "3PM", reb: "REB", ast: "AST", stl: "STL", blk: "BLK", fgPct: "FG%", ftPct: "FT%", tov: "TO", value: "Value",
};
const COUNTING = ["fg3m", "pts", "reb", "ast", "stl", "blk"] as const;
const TIER_CLASS: Record<RankTier, string | undefined> = {
  top10: styles.top10, top25: styles.top25, top40: styles.top40, mid: undefined, bottom25: styles.bottom25, bottom10: styles.bottom10,
};

function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function tipTime(g: BoxScoreGame, timeZone: string): string {
  if (!g.tipoff) return "TBD";
  return new Date(g.tipoff).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" });
}

export default function BoxScoresView({ data, initialGame = null }: { data: BoxScoresResponse; initialGame?: number | null }) {
  const router = useRouter();
  const [adding, setAdding] = useState<number | null>(null);
  const onAdd = useSignedIn() ? setAdding : null;
  const { sbRef, pinned, active } = usePinnedBar(data.games);
  const live = useLiveRefresh(data.live);
  const pick = useCallback((id: number) => jumpTo(id), []);

  useEffect(() => {
    if (initialGame !== null) jumpTo(initialGame, false);
  }, [initialGame]);
  const prev = addDays(data.date, -1);
  const next = addDays(data.date, 1);
  const inSeason = (iso: string) => (!data.firstDate || iso >= data.firstDate) && (!data.lastDate || iso <= data.lastDate);

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <SiteHeader />
        <PlayerModalHost>
          <h1 className={styles.title}>Box scores</h1>
          {data.live && (
            <p className={styles.sub}>
              {/* Floats at the top once scrolled off, until the pinned bar (with its own) shows. */}
              <b><LiveCountdown nextAt={live.nextAt} pending={live.pending} pin={!pinned} /></b>
            </p>
          )}

          <nav className={styles.dbar} aria-label="Date">
            <DayLink to={prev} disabled={!inSeason(prev)} label="Previous day" arrow="M15 18l-6-6 6-6" />
            {data.days.map((d) => (
              <Link
                key={d.date}
                href={href(d.date)}
                className={`${styles.day} ${d.date === data.date ? styles.dayOn : ""}`}
                aria-current={d.date === data.date ? "date" : undefined}
              >
                {d.date === data.today ? "Today" : `${weekday(d.date)} ${Number(d.date.slice(8))}`}
                <small>{d.date === data.today ? `${weekday(d.date)} ${Number(d.date.slice(8))}` : `${d.games} ${d.games === 1 ? "game" : "games"}`}</small>
              </Link>
            ))}
            <DayLink to={next} disabled={!inSeason(next)} label="Next day" arrow="M9 18l6-6-6-6" />
            <label className={styles.dpick}>
              Go to date
              <input
                type="date"
                value={data.date}
                min={data.firstDate ?? undefined}
                max={data.lastDate ?? undefined}
                onChange={(e) => e.target.value && router.push(href(e.target.value))}
              />
            </label>
          </nav>

          {data.games.length === 0 ? (
            <p className={styles.empty}>No NBA games on this date.</p>
          ) : (
            <>
              <nav ref={sbRef} className={styles.sb} aria-label="Games">
                {data.games.map((g) => (
                  <GameCard key={g.id} g={g} timeZone={data.timeZone} onPick={() => pick(g.id)} />
                ))}
              </nav>
              <PinnedBar games={data.games} shown={pinned} active={active} timeZone={data.timeZone} onPick={pick} live={data.live ? live : null} />

              <div className={styles.lg} aria-label="Shading key">
                <span>Each stat is ranked against every player on this date:</span>
                <i className={styles.top10}>Top 10%</i>
                <i className={styles.top25}>Top 25%</i>
                <i className={styles.top40}>Top 40%</i>
                <i>Middle</i>
                <i className={styles.bottom25}>Bottom 25%</i>
                <i className={styles.bottom10}>Bottom 10%</i>
              </div>

              {data.games.map((g) => (
                <Box key={g.id} g={g} data={data} onAdd={onAdd} />
              ))}
            </>
          )}

        </PlayerModalHost>
        {onAdd && <AddDropSheet playerId={adding} onClose={() => setAdding(null)} onDone={() => router.refresh()} />}
      </div>
    </div>
  );
}

function DayLink({ to, disabled, label, arrow }: { to: string; disabled: boolean; label: string; arrow: string }) {
  const icon = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={arrow} />
    </svg>
  );
  return disabled ? (
    <span className={styles.arw} aria-label={label} aria-disabled="true" role="link">
      {icon}
    </span>
  ) : (
    <Link href={href(to)} className={styles.arw} aria-label={label}>
      {icon}
    </Link>
  );
}

function winnerOf(g: BoxScoreGame): "away" | "home" | null {
  if (g.state !== "final" || g.away.score === null || g.home.score === null) return null;
  return g.away.score > g.home.score ? "away" : g.home.score > g.away.score ? "home" : null;
}

function GameCard({ g, timeZone, onPick }: { g: BoxScoreGame; timeZone: string; onPick: () => void }) {
  const winner = winnerOf(g);
  const dim = (side: "away" | "home") => (winner !== null && winner !== side ? styles.lost : "");
  return (
    <button type="button" className={styles.gm} onClick={onPick}>
      <Flash className={`${styles.st} ${g.state === "live" ? styles.live : ""}`} value={g.statusText} scope={g.id}>
        {g.state === "scheduled" ? tipTime(g, timeZone) : g.statusText && fmtGameStatus(g.statusText)}
      </Flash>
      <span className={`${styles.tl} ${dim("away")}`}>
        <b>{g.away.abbreviation}</b>
        <Flash as="em" value={g.away.score} scope={g.id}>{g.away.score ?? ""}</Flash>
      </span>
      <span className={`${styles.tl} ${dim("home")}`}>
        <b>@ {g.home.abbreviation}</b>
        <Flash as="em" value={g.home.score} scope={g.id}>{g.home.score ?? ""}</Flash>
      </span>
      {g.mine.length > 0 && <span className={styles.mi}>{g.mine.length} of yours</span>}
    </button>
  );
}

/**
 * The compact scoreboard pinned to the top of the page once the full one has scrolled
 * off. A zero-height sticky slot holds it, so showing it never shifts the page.
 * Hidden (and out of the tab order) while the full scoreboard is on screen.
 */
function PinnedBar({ games, shown, active, timeZone, onPick, live }: {
  games: BoxScoreGame[]; shown: boolean; active: number | null; timeZone: string; onPick: (id: number) => void;
  /** While games are live: the countdown to the next update, shown at the bar's end. */
  live: { nextAt: number | null; pending: boolean } | null;
}) {
  const rowRef = useRef<HTMLDivElement>(null);

  // Keep the game being read in view along the row (sideways only; never scroll the page).
  useEffect(() => {
    const row = rowRef.current;
    const chip = active === null ? null : row?.querySelector<HTMLElement>(`[data-game="${active}"]`);
    if (!row || !chip) return;
    const left = chip.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft || left + chip.offsetWidth > row.scrollLeft + row.clientWidth) {
      row.scrollTo({ left: left - 16, behavior: "smooth" });
    }
  }, [active, shown]);

  return (
    <div className={styles.pinSlot} data-shown={shown || undefined}>
      <nav className={styles.pin} aria-label="Games (pinned)" aria-hidden={!shown}>
        <div ref={rowRef} className={styles.pinRow}>
          {games.map((g) => {
            const winner = winnerOf(g);
            const dim = (side: "away" | "home") => (winner !== null && winner !== side ? styles.lost : "");
            const on = g.id === active;
            return (
              <button
                key={g.id}
                type="button"
                data-game={g.id}
                className={`${styles.chip} ${on ? styles.chipOn : ""}`}
                aria-current={on ? "location" : undefined}
                tabIndex={shown ? undefined : -1}
                onClick={() => onPick(g.id)}
              >
                <span className={styles.chipTeams}>
                  <span className={dim("away")}>
                    <b>{g.away.abbreviation}</b>
                    <Flash as="em" value={g.away.score} scope={g.id}>{g.away.score ?? ""}</Flash>
                  </span>
                  <span className={dim("home")}>
                    <b>{g.home.abbreviation}</b>
                    <Flash as="em" value={g.home.score} scope={g.id}>{g.home.score ?? ""}</Flash>
                  </span>
                </span>
                <Flash className={`${styles.chipSt} ${g.state === "live" ? styles.live : ""}`} value={g.statusText} scope={g.id}>
                  {g.state === "scheduled" ? tipTime(g, timeZone).replace(/ [A-Z]{2,4}$/, "") : g.statusText && fmtGameStatus(g.statusText)}
                  {g.mine.length > 0 && <i>{g.mine.length} of yours</i>}
                </Flash>
              </button>
            );
          })}
        </div>
        {live && (
          <span className={styles.pinLive}>
            <LiveCountdown nextAt={live.nextAt} pending={live.pending} compact />
          </span>
        )}
      </nav>
    </div>
  );
}

function Box({ g, data, onAdd }: { g: BoxScoreGame; data: BoxScoresResponse; onAdd: ((id: number) => void) | null }) {
  const started = g.away.score !== null && g.home.score !== null;
  const title = started
    ? `${g.away.abbreviation} ${g.away.score} @ ${g.home.abbreviation} ${g.home.score}`
    : `${g.away.abbreviation} @ ${g.home.abbreviation}`;
  const hasRows = g.away.players.length + g.home.players.length > 0;
  return (
    <section id={boxId(g.id)} className={styles.box} aria-label={title}>
      <div className={styles.bh}>
        <h2>{title}</h2>
        {g.state !== "scheduled" && (
          <Flash className={`${styles.bst} ${g.state === "live" ? styles.live : ""}`} value={g.statusText} scope={g.id}>
            {g.statusText && fmtGameStatus(g.statusText)}
          </Flash>
        )}
      </div>
      {!hasRows ? (
        <p className={styles.empty}>
          {g.state === "postponed" ? (
            <b>Postponed.</b>
          ) : g.state === "scheduled" ? (
            <>
              <b>Tips at {tipTime(g, data.timeZone)}.</b> The box score fills in once the game starts.
            </>
          ) : (
            <b>No stats yet.</b>
          )}
          {g.mine.length > 0 && ` Your players in this game: ${g.mine.join(", ").replace(/\.?$/, ".")}`}
        </p>
      ) : (
        [g.away, g.home].map((t) => (
          <TeamTable key={t.id} t={t} other={t === g.away ? g.home : g.away} g={g} data={data} onAdd={onAdd} />
        ))
      )}
    </section>
  );
}

function TeamTable({ t, other, g, data, onAdd }: {
  t: BoxScoreTeam; other: BoxScoreTeam; g: BoxScoreGame; data: BoxScoresResponse; onAdd: ((id: number) => void) | null;
}) {
  const result = g.state === "final" && t.score !== null && other.score !== null && t.score !== other.score
    ? (t.score > other.score ? "Won" : "Lost") : null;
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  useFlipRows(bodyRef);
  const tot = t.totals;
  return (
    <div className={styles.card}>
      <h3>
        <span>
          {t.abbreviation}
          {t.score !== null && <> · <Flash value={t.score} scope={t.id}>{t.score}</Flash></>}
        </span>
        {result && <span className={styles.result}>{result}</span>}
      </h3>
      <StickyHeadTable
        tableClassName={`${styles.table} ${onAdd ? "" : styles.noOwner}`}
        head={() => (
          <thead>
            <tr>
              <th scope="col" className={styles.rk} title="Rank by Value among every player who played on this date">Rank</th>
              <th scope="col" className={styles.pl}>Player</th>
              {onAdd && <th scope="col" className={styles.own}>Owner</th>}
              <th scope="col" className={styles.n}>MIN</th>
              <th scope="col" className={styles.n}>FG%</th>
              <th scope="col" className={styles.n}>FT%</th>
              {COUNTING.map((k) => (
                <th key={k} scope="col" className={styles.n}>{LABELS[k]}</th>
              ))}
              <th scope="col" className={styles.n}>TO</th>
              <th scope="col" className={styles.n} title="Personal fouls">PF</th>
              <th scope="col" className={`${styles.n} ${styles.srt}`} aria-sort="descending">Value</th>
            </tr>
          </thead>
        )}
      >
        <tbody ref={bodyRef}>
          {t.players.map((p) => (
            <PlayerRow key={p.id} p={p} data={data} onAdd={onAdd} />
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className={styles.rk} />
            <th scope="row" className={styles.pl}>Team totals</th>
            {onAdd && <td />}
            <td className={styles.n}>{tot.min}</td>
            <td className={styles.n}>
              <Flash className={styles.c} value={`${tot.fgm}/${tot.fga}`} scope={t.id} delta={shotsDelta(tot.fgm, tot.fga)}>
                {fmtPct(tot.fgPct)}
                <small>{tot.fgm}/{tot.fga}</small>
              </Flash>
            </td>
            <td className={styles.n}>
              <Flash className={styles.c} value={`${tot.ftm}/${tot.fta}`} scope={t.id} delta={shotsDelta(tot.ftm, tot.fta)}>
                {fmtPct(tot.ftPct)}
                <small>{tot.ftm}/{tot.fta}</small>
              </Flash>
            </td>
            {COUNTING.map((k) => (
              <td key={k} className={styles.n}>
                <Flash className={styles.c} value={tot[k]} scope={t.id} delta={count(tot[k])}>{tot[k]}</Flash>
              </td>
            ))}
            <td className={styles.n}>
              <Flash className={styles.c} value={tot.tov} scope={t.id} delta={count(tot.tov, true)}>{tot.tov}</Flash>
            </td>
            <td className={styles.n}>
              <Flash className={styles.c} value={tot.pf} scope={t.id} delta={count(tot.pf, true)}>{tot.pf}</Flash>
            </td>
            <td />
          </tr>
        </tfoot>
      </StickyHeadTable>
    </div>
  );
}

function rankTitle(k: BoxRankKey, r: BoxRank | undefined, of: number): string {
  if (!r) return `${LABELS[k]}: no attempts`;
  return `${LABELS[k]}: ${r.tied ? "T-" : ""}${ordinal(r.rank)} of ${of} players on this date`;
}

/**
 * A stat cell, shaded by its rank tier. `value` is what flashes when it changes (live
 * updates; `scope` is the player); `delta` also shows the change.
 */
function Cell({ k, r, of, value, scope, delta, children }: {
  k: BoxRankKey; r: BoxRank | undefined; of: number; value: string | number; scope: number; delta?: FlashDelta; children: React.ReactNode;
}) {
  return (
    <td className={styles.n}>
      <Flash className={`${styles.c} ${r ? TIER_CLASS[r.tier] ?? "" : ""}`} title={rankTitle(k, r, of)} value={value} scope={scope} delta={delta}>
        {children}
      </Flash>
    </td>
  );
}

function PlayerRow({ p, data, onAdd }: { p: BoxScorePlayer; data: BoxScoresResponse; onAdd: ((id: number) => void) | null }) {
  const mine = p.owner !== null && p.owner.teamId === data.myTeamId;
  const l = p.line;
  const of = data.playerCount;
  return (
    <tr data-flip={p.id} className={`${mine ? styles.mine : ""} ${l ? "" : styles.out}`}>
      <td className={styles.rk} title={l ? rankTitle("value", p.ranks.value, of) : undefined}>
        {/* Flashes (with ▲/▼) only when his own Value changed and moved him, not when others' lines did. */}
        <Flash value={l ? p.value : null} scope={p.id} delta={{ n: l ? p.ranks.value?.rank ?? null : null, kind: "rank" }}>
          {l && p.ranks.value ? `${p.ranks.value.tied ? "T-" : ""}${p.ranks.value.rank}` : "–"}
        </Flash>
      </td>
      <th scope="row" className={styles.pl}>
        <PlayerButton playerId={p.id}>
          <span className={styles.name}>
            <span data-player-name><ScrollName firstName={p.firstName} lastName={p.lastName} /></span>
            {p.position && <small>{p.position}</small>}
          </span>
        </PlayerButton>
      </th>
      {onAdd && <td className={styles.own}>
        {p.owner === null && p.waiver ? (
          <button
            type="button"
            className={`${styles.add} ${styles.claim}`}
            aria-label={`Claim ${fullName(p)} (${waiverTooltip(p.waiver, data.timeZone)})`}
            title={waiverTooltip(p.waiver, data.timeZone)}
            onClick={() => onAdd(p.id)}
          >
            Claim
          </button>
        ) : p.owner === null ? (
          <button type="button" className={styles.add} aria-label={`Add ${fullName(p)}`} onClick={() => onAdd(p.id)}>
            Add
          </button>
        ) : mine ? (
          <span className={styles.mp}><TeamLink team={{ id: p.owner.teamId, name: p.owner.abbreviation }} myTeamId={data.myTeamId} /></span>
        ) : (
          <TeamLink team={{ id: p.owner.teamId, name: p.owner.abbreviation }} myTeamId={data.myTeamId} />
        )}
      </td>}
      {l ? (
        <>
          <td className={styles.n}>{l.min}</td>
          <Cell k="fgPct" r={p.ranks.fgPct} of={of} value={`${l.fgm}/${l.fga}`} scope={p.id} delta={shotsDelta(l.fgm, l.fga)}>
            {fmtPct(l.fgPct)}
            <small>{l.fgm}/{l.fga}</small>
          </Cell>
          <Cell k="ftPct" r={p.ranks.ftPct} of={of} value={`${l.ftm}/${l.fta}`} scope={p.id} delta={shotsDelta(l.ftm, l.fta)}>
            {fmtPct(l.ftPct)}
            <small>{l.ftm}/{l.fta}</small>
          </Cell>
          {COUNTING.map((k) => (
            <Cell key={k} k={k} r={p.ranks[k]} of={of} value={l[k]} scope={p.id} delta={count(l[k])}>{l[k]}</Cell>
          ))}
          <Cell k="tov" r={p.ranks.tov} of={of} value={l.tov} scope={p.id} delta={count(l.tov, true)}>{l.tov}</Cell>
          <td className={styles.n} title={l.pf >= 6 ? "Fouled out" : undefined}>
            <Flash className={styles.c} value={l.pf} scope={p.id} delta={count(l.pf, true)}>{l.pf}</Flash>
          </td>
          <Cell k="value" r={p.ranks.value} of={of} value={p.value ?? 0} scope={p.id}>
            <b>{fmtValue(p.value ?? 0)}</b>
          </Cell>
        </>
      ) : (
        <td colSpan={12} className={styles.dnp}>DNP</td>
      )}
    </tr>
  );
}

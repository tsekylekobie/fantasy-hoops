"use client";

// The /box-scores page: the Box scores artboard in the Fantasy Hoops design
// canvas. A date's scoreboard, then each game's box score. Every stat cell is
// shaded by where it ranks among all players who played that date (queries/boxScores.ts).
// Keyed by date and ?game (page.tsx), so the picked game resets when either changes.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { BoxRank, BoxRankKey, BoxScoreGame, BoxScorePlayer, BoxScoresResponse, BoxScoreTeam, RankTier } from "@/lib/types";
import SiteHeader from "@/components/SiteHeader";
import PlayerModalHost, { PlayerButton } from "@/components/players/PlayerModalHost";
import AddDropSheet from "@/components/transactions/AddDropSheet";
import LiveRefresh from "@/components/live/LiveRefresh";
import { fmtGameDate, fmtPct, fmtValue, fmtWaiverTime, fullName } from "@/components/players/format";
import styles from "./BoxScoresView.module.css";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekday = (iso: string) => WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const href = (date: string) => `/box-scores?date=${date}`;

const LABELS: Record<BoxRankKey, string> = {
  pts: "PTS", fg3m: "3PM", reb: "REB", ast: "AST", stl: "STL", blk: "BLK", fgPct: "FG%", ftPct: "FT%", tov: "TO", value: "Value",
};
const COUNTING = ["pts", "fg3m", "reb", "ast", "stl", "blk"] as const;
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

/** "Sun, Oct 25 · 7 games · 3 final, 3 in progress, 1 later" */
function summary(d: BoxScoresResponse): string {
  const label = `${weekday(d.date)}, ${fmtGameDate(d.date)}`;
  if (d.games.length === 0) return `${label} · No games`;
  const n = (s: BoxScoreGame["state"]) => d.games.filter((g) => g.state === s).length;
  const parts = [
    n("final") && `${n("final")} final`,
    n("live") && `${n("live")} in progress`,
    n("scheduled") && `${n("scheduled")} ${d.date === d.today ? "later today" : "scheduled"}`,
    n("postponed") && `${n("postponed")} postponed`,
  ].filter(Boolean);
  return `${label} · ${d.games.length} ${d.games.length === 1 ? "game" : "games"} · ${parts.join(", ")}`;
}

export default function BoxScoresView({ data, initialGame = null }: { data: BoxScoresResponse; initialGame?: number | null }) {
  const router = useRouter();
  const [game, setGame] = useState<number | "all">(initialGame ?? "all");
  const [adding, setAdding] = useState<number | null>(null);
  const shown = game === "all" ? data.games : data.games.filter((g) => g.id === game);
  const prev = addDays(data.date, -1);
  const next = addDays(data.date, 1);
  const inSeason = (iso: string) => (!data.firstDate || iso >= data.firstDate) && (!data.lastDate || iso <= data.lastDate);

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <SiteHeader />
        <LiveRefresh active={data.live} />
        <PlayerModalHost>
          <h1 className={styles.title}>Box scores</h1>
          <p className={styles.sub}>
            {summary(data)}
            {data.live && <b> · Live games update every 30 seconds</b>}
          </p>

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
              <div className={styles.sb}>
                <button
                  type="button"
                  className={`${styles.gm} ${styles.all} ${game === "all" ? styles.gmOn : ""}`}
                  aria-pressed={game === "all"}
                  onClick={() => setGame("all")}
                >
                  <b>All games</b>
                  <span>{data.games.length} {data.games.length === 1 ? "game" : "games"}</span>
                </button>
                {data.games.map((g) => (
                  <GameCard key={g.id} g={g} on={game === g.id} timeZone={data.timeZone} onPick={() => setGame(g.id)} />
                ))}
              </div>

              <div className={styles.lg} aria-label="Shading key">
                <span>Each stat is ranked against every player on this date:</span>
                <i className={styles.top10}>Top 10%</i>
                <i className={styles.top25}>Top 25%</i>
                <i className={styles.top40}>Top 40%</i>
                <i>Middle</i>
                <i className={styles.bottom25}>Bottom 25%</i>
                <i className={styles.bottom10}>Bottom 10%</i>
              </div>

              {shown.map((g) => (
                <Box key={g.id} g={g} data={data} onAdd={setAdding} />
              ))}
            </>
          )}

          <p className={styles.ft}>
            Shading ranks each stat against every player who played on this date, across all games. FG% and FT% rank by
            how much a line moves a team’s percentage (makes above the league rate, so volume counts: 8/10 beats 1/1); no
            attempts, no shading. Fewer turnovers ranks higher. Value is this game’s weighted average of category
            z-scores, on the same per-game scale and punt weights as Players. In-progress games count with their stats so
            far. Hover a cell for its rank.
          </p>
        </PlayerModalHost>
        <AddDropSheet playerId={adding} onClose={() => setAdding(null)} onDone={() => router.refresh()} />
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

function GameCard({ g, on, timeZone, onPick }: { g: BoxScoreGame; on: boolean; timeZone: string; onPick: () => void }) {
  const started = g.away.score !== null && g.home.score !== null;
  const winner = g.state === "final" && started ? (g.away.score! > g.home.score! ? "away" : g.home.score! > g.away.score! ? "home" : null) : null;
  const dim = (side: "away" | "home") => (winner !== null && winner !== side ? styles.lost : "");
  return (
    <button type="button" className={`${styles.gm} ${on ? styles.gmOn : ""}`} aria-pressed={on} onClick={onPick}>
      <span className={`${styles.st} ${g.state === "live" ? styles.live : ""}`}>
        {g.state === "scheduled" ? tipTime(g, timeZone) : g.statusText}
      </span>
      <span className={`${styles.tl} ${dim("away")}`}>
        <b>{g.away.abbreviation}</b>
        <em>{g.away.score ?? ""}</em>
      </span>
      <span className={`${styles.tl} ${dim("home")}`}>
        <b>@ {g.home.abbreviation}</b>
        <em>{g.home.score ?? ""}</em>
      </span>
      {g.mine.length > 0 && <span className={styles.mi}>{g.mine.length} of yours</span>}
    </button>
  );
}

function Box({ g, data, onAdd }: { g: BoxScoreGame; data: BoxScoresResponse; onAdd: (id: number) => void }) {
  const started = g.away.score !== null && g.home.score !== null;
  const title = started
    ? `${g.away.abbreviation} ${g.away.score} @ ${g.home.abbreviation} ${g.home.score}`
    : `${g.away.abbreviation} @ ${g.home.abbreviation}`;
  const hasRows = g.away.players.length + g.home.players.length > 0;
  return (
    <section className={styles.box} aria-label={title}>
      <div className={styles.bh}>
        <h2>{title}</h2>
        {g.state !== "scheduled" && <span className={`${styles.bst} ${g.state === "live" ? styles.live : ""}`}>{g.statusText}</span>}
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
  t: BoxScoreTeam; other: BoxScoreTeam; g: BoxScoreGame; data: BoxScoresResponse; onAdd: (id: number) => void;
}) {
  const result = g.state === "final" && t.score !== null && other.score !== null && t.score !== other.score
    ? (t.score > other.score ? "Won" : "Lost") : null;
  return (
    <div className={styles.card}>
      <h3>
        {t.abbreviation}
        {t.score !== null && ` · ${t.score}`}
        {result && <span>{result}</span>}
      </h3>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.rk} title="Rank by Value among every player who played on this date">Rank</th>
              <th scope="col" className={styles.pl}>Player</th>
              <th scope="col" className={styles.own}>Owner</th>
              <th scope="col" className={styles.n}>MIN</th>
              {COUNTING.map((k) => (
                <th key={k} scope="col" className={styles.n}>{LABELS[k]}</th>
              ))}
              <th scope="col" className={styles.n}>FG%</th>
              <th scope="col" className={styles.n}>FT%</th>
              <th scope="col" className={styles.n}>TO</th>
              <th scope="col" className={`${styles.n} ${styles.srt}`} aria-sort="descending">Value</th>
            </tr>
          </thead>
          <tbody>
            {t.players.map((p) => (
              <PlayerRow key={p.id} p={p} data={data} onAdd={onAdd} />
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className={styles.rk} />
              <th scope="row" className={styles.pl}>Team totals</th>
              <td />
              <td className={styles.n}>{t.totals.min}</td>
              {COUNTING.map((k) => (
                <td key={k} className={styles.n}>{t.totals[k]}</td>
              ))}
              <td className={styles.n}>
                {fmtPct(t.totals.fgPct)}
                <small>{t.totals.fgm}/{t.totals.fga}</small>
              </td>
              <td className={styles.n}>
                {fmtPct(t.totals.ftPct)}
                <small>{t.totals.ftm}/{t.totals.fta}</small>
              </td>
              <td className={styles.n}>{t.totals.tov}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function rankTitle(k: BoxRankKey, r: BoxRank | undefined, of: number): string {
  if (!r) return `${LABELS[k]}: no attempts`;
  return `${LABELS[k]}: ${r.tied ? "T-" : ""}${ordinal(r.rank)} of ${of} players on this date`;
}

function Cell({ k, r, of, children }: { k: BoxRankKey; r: BoxRank | undefined; of: number; children: React.ReactNode }) {
  return (
    <td className={styles.n}>
      <span className={`${styles.c} ${r ? TIER_CLASS[r.tier] ?? "" : ""}`} title={rankTitle(k, r, of)}>
        {children}
      </span>
    </td>
  );
}

function PlayerRow({ p, data, onAdd }: { p: BoxScorePlayer; data: BoxScoresResponse; onAdd: (id: number) => void }) {
  const mine = p.owner !== null && p.owner.teamId === data.myTeamId;
  const l = p.line;
  const of = data.playerCount;
  return (
    <tr className={`${mine ? styles.mine : ""} ${l ? "" : styles.out}`}>
      <td className={styles.rk} title={l ? rankTitle("value", p.ranks.value, of) : undefined}>
        {l && p.ranks.value ? `${p.ranks.value.tied ? "T-" : ""}${p.ranks.value.rank}` : "–"}
      </td>
      <th scope="row" className={styles.pl}>
        <PlayerButton playerId={p.id}>
          <span className={styles.name}>
            <span data-player-name>{fullName(p)}</span>
            {p.position && <small>{p.position}</small>}
          </span>
        </PlayerButton>
      </th>
      <td className={styles.own}>
        {p.owner === null && p.waiver ? (
          <button
            type="button"
            className={`${styles.add} ${styles.claim}`}
            aria-label={`Claim ${fullName(p)} (on waivers, clears ${fmtWaiverTime(p.waiver.clearsAt, data.timeZone, "long")})`}
            title={`On waivers until ${fmtWaiverTime(p.waiver.clearsAt, data.timeZone, "long")}`}
            onClick={() => onAdd(p.id)}
          >
            Claim
          </button>
        ) : p.owner === null ? (
          <button type="button" className={styles.add} aria-label={`Add ${fullName(p)}`} onClick={() => onAdd(p.id)}>
            Add
          </button>
        ) : mine ? (
          <span className={styles.mp}>{p.owner.abbreviation}</span>
        ) : (
          p.owner.abbreviation
        )}
      </td>
      {l ? (
        <>
          <td className={styles.n}>{l.min}</td>
          {COUNTING.map((k) => (
            <Cell key={k} k={k} r={p.ranks[k]} of={of}>{l[k]}</Cell>
          ))}
          <Cell k="fgPct" r={p.ranks.fgPct} of={of}>
            {fmtPct(l.fgPct)}
            <small>{l.fgm}/{l.fga}</small>
          </Cell>
          <Cell k="ftPct" r={p.ranks.ftPct} of={of}>
            {fmtPct(l.ftPct)}
            <small>{l.ftm}/{l.fta}</small>
          </Cell>
          <Cell k="tov" r={p.ranks.tov} of={of}>{l.tov}</Cell>
          <Cell k="value" r={p.ranks.value} of={of}>
            <b>{fmtValue(p.value ?? 0)}</b>
          </Cell>
        </>
      ) : (
        <td colSpan={11} className={styles.dnp}>DNP</td>
      )}
    </tr>
  );
}

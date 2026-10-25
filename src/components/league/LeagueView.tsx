// The /league page: docs/design/league.mockup.html (standings), plus this
// week's scoreboard. Team names open that team's roster (yours is /my-team);
// a score opens that matchup. Trades in review (and yours) sit below.
import Link from "next/link";
import type { FantasyTeamSummary, LeagueOverview, MatchupScore, OtherMatchup } from "@/lib/types";
import SiteHeader from "@/components/SiteHeader";
import TradesPanel from "@/components/trades/TradesPanel";
import { fmtGameDate } from "@/components/players/format";
import styles from "./LeagueView.module.css";

/** 5–3–1 */
const fmtScore = (s: MatchupScore) => `${s.wins}–${s.losses}–${s.ties}`;

/** .611, or 1.000 */
const fmtPct = (p: number | null) => (p === null ? "–" : p >= 1 ? "1.000" : p.toFixed(3).slice(1));

/** "Oct 20–25", or "Oct 27 – Nov 2" across months. */
function fmtRange(from: string, to: string): string {
  const a = fmtGameDate(from);
  const b = fmtGameDate(to);
  return a.slice(0, 3) === b.slice(0, 3) ? `${a}–${b.slice(4)}` : `${a} – ${b}`;
}

const teamHref = (t: FantasyTeamSummary, myTeam: FantasyTeamSummary | null) =>
  t.id === myTeam?.id ? "/my-team" : `/team/${t.id}`;

export default function LeagueView({ data }: { data: LeagueOverview | null }) {
  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <SiteHeader />
        {data ? <Overview data={data} /> : <p className={styles.empty}>No league for this season yet.</p>}
      </div>
    </div>
  );
}

function Overview({ data }: { data: LeagueOverview }) {
  const season = `${data.season}–${String(data.season + 1).slice(2)}`;
  return (
    <>
      <h1 className={styles.title}>League</h1>
      <p className={styles.sub}>
        {data.name} · {data.teamCount} teams · Head-to-head, 9 categories · {season}
      </p>
      <div className={styles.cols}>
        <Standings data={data} />
        <Scoreboard data={data} />
      </div>
      <TradesPanel scope="league" />
    </>
  );
}

function Standings({ data }: { data: LeagueOverview }) {
  const counted = data.includesLiveWeek
    ? `${data.weeksCounted - 1} finished week${data.weeksCounted === 2 ? "" : "s"} plus this week’s live score`
    : `${data.weeksCounted} week${data.weeksCounted === 1 ? "" : "s"}`;
  return (
    <section className={styles.card}>
      <h3>Standings</h3>
      <div role="table" aria-label="Standings">
        <div className={`${styles.s} ${styles.h}`} role="row">
          <span role="columnheader">#</span>
          <span role="columnheader">Team</span>
          <span role="columnheader" className={styles.n}>W–L–T</span>
          <span role="columnheader" className={styles.n}>Pct</span>
          <span role="columnheader" className={`${styles.n} ${styles.opt}`}>GB</span>
          <span role="columnheader" className={`${styles.n} ${styles.opt}`}>Moves</span>
        </div>
        {data.standings.map((t, i) => (
          <div
            key={t.id}
            role="row"
            className={[styles.s, t.isMine && styles.mine, i === data.playoffTeams && styles.cut].filter(Boolean).join(" ")}
          >
            <span role="cell">{t.rank}</span>
            <span role="cell" className={styles.tn}>
              <i aria-hidden="true">{t.abbreviation}</i>
              <Link href={teamHref(t, data.myTeam)}>{t.name}</Link>
            </span>
            <span role="cell" className={styles.n}>{fmtScore(t.record)}</span>
            <span role="cell" className={styles.n}>{fmtPct(t.pct)}</span>
            <span role="cell" className={`${styles.n} ${styles.opt}`}>{t.gamesBack === 0 ? "–" : t.gamesBack.toFixed(1)}</span>
            <span role="cell" className={`${styles.n} ${styles.opt}`}>{t.moves}</span>
          </div>
        ))}
      </div>
      <p className={styles.foot}>
        Category record across {data.weeksCounted === 0 ? "every week (none played yet)" : counted}.
        {" "}Top {data.playoffTeams} make the playoffs (dashed line). Team names open that team’s roster.
      </p>
    </section>
  );
}

function Scoreboard({ data }: { data: LeagueOverview }) {
  const w = data.week;
  if (!w) return null;
  const state = w.status === "live" ? "Live" : w.status === "final" ? "Final" : "Upcoming";
  return (
    <section className={styles.card}>
      <h3>
        {w.isPlayoffs ? "Playoffs · " : ""}Week {w.week}
        <span className={styles.when}>{fmtRange(w.startsOn, w.endsOn)} · {state}</span>
      </h3>
      {data.matchups.map((m) => <ScoreRow key={m.teamA.id} m={m} week={w.week} />)}
      <p className={styles.foot}>Categories won–lost–tied, for the team on the left. Tap a matchup for the box score.</p>
    </section>
  );
}

function ScoreRow({ m, week }: { m: OtherMatchup; week: number }) {
  const side = (t: FantasyTeamSummary, right?: boolean) => (
    <span className={`${styles.side} ${right ? styles.r : ""}`}>
      <i aria-hidden="true">{t.abbreviation}</i>
      <span>{t.name}</span>
    </span>
  );
  if (!m.teamB) {
    return (
      <div className={styles.m}>
        {side(m.teamA)}
        <b>Bye</b>
        <span />
      </div>
    );
  }
  // The matchup page puts your team on the left on its own; other matchups open by team.
  const href = m.isMine ? `/matchup?week=${week}` : `/matchup?week=${week}&team=${m.teamA.id}`;
  return (
    <Link
      href={href}
      className={`${styles.m} ${styles.link} ${m.isMine ? styles.mine : ""}`}
      aria-label={`${m.teamA.name} ${fmtScore(m.score)} ${m.teamB.name}${m.isMine ? " (your matchup)" : ""}`}
    >
      {side(m.teamA)}
      <b>{fmtScore(m.score)}</b>
      {side(m.teamB, true)}
    </Link>
  );
}

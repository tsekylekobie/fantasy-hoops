// The /matchup page: docs/design/matchup.mockup.html.
import Link from "next/link";
import type { CategoryKey, CategoryLine, CategoryResult, MatchupScore, MatchupSide, MatchupWeek } from "@/lib/types";
import { CATEGORY_KEYS } from "@/lib/types";
import SiteHeader from "@/components/SiteHeader";
import { fmtGameDate, fmtInt, fmtPct } from "@/components/players/format";
import styles from "./MatchupView.module.css";

const LABELS: Record<CategoryKey, string> = {
  fgPct: "FG%", ftPct: "FT%", fg3m: "3PM", pts: "PTS", reb: "REB", ast: "AST", stl: "STL", blk: "BLK", tov: "TO",
};

const RESULT_LABEL: Record<CategoryResult, string> = { win: "Win", loss: "Loss", tie: "Tie" };
const FLIP: Record<CategoryResult, CategoryResult> = { win: "loss", loss: "win", tie: "tie" };

/** 5–3–1 */
function fmtScore(s: MatchupScore): string {
  return `${s.wins}–${s.losses}–${s.ties}`;
}

/** "Oct 20–25", or "Oct 27 – Nov 2" across months. */
function fmtRange(from: string, to: string): string {
  const a = fmtGameDate(from);
  const b = fmtGameDate(to);
  return a.slice(0, 3) === b.slice(0, 3) ? `${a}–${b.slice(4)}` : `${a} – ${b}`;
}

function weekTitle(d: MatchupWeek): string {
  const parts = [`${d.isPlayoffs ? "Playoffs · " : ""}Week ${d.week}`, fmtRange(d.startsOn, d.endsOn)];
  if (d.status === "live") parts.push(`Day ${d.day} of ${d.days}`);
  else parts.push(d.status === "final" ? "Final" : "Upcoming");
  return parts.join(" · ");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default function MatchupView({ data, signedIn }: { data: MatchupWeek | null; signedIn: boolean }) {
  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <SiteHeader />
        {data ? <Week data={data} signedIn={signedIn} /> : (
          <p className={styles.empty}>No league schedule for this season yet.</p>
        )}
      </div>
    </div>
  );
}

function Week({ data, signedIn }: { data: MatchupWeek; signedIn: boolean }) {
  const { matchup: m } = data;
  return (
    <>
      <div className={styles.wk}>
        <h1>{weekTitle(data)}</h1>
        <nav className={styles.pager} aria-label="Weeks">
          <PagerLink week={data.week - 1} disabled={data.week <= 1}>Previous week</PagerLink>
          <PagerLink week={data.week + 1} disabled={data.week >= data.weekCount}>Next week</PagerLink>
        </nav>
      </div>

      {m ? (
        <>
          <Scoreboard team={m.team} opponent={m.opponent} score={m.score} upcoming={data.status === "upcoming"} />
          <div className={styles.cols}>
            <Categories team={m.team} opponent={m.opponent} results={m.results} />
            <div className={styles.stack}>
              {data.status !== "final" && <GamesLeft data={data} team={m.team} opponent={m.opponent} />}
              <AroundTheLeague data={data} />
            </div>
          </div>
        </>
      ) : (
        <div className={styles.cols}>
          <div className={`${styles.card} ${styles.notice}`}>
            {!signedIn ? (
              <p>Sign in to see your matchup.</p>
            ) : !data.myTeam ? (
              <p>You don’t have a team in this league.</p>
            ) : (
              <p>{data.myTeam.name} has no matchup this week.</p>
            )}
          </div>
          <AroundTheLeague data={data} />
        </div>
      )}
    </>
  );
}

function PagerLink({ week, disabled, children }: { week: number; disabled: boolean; children: React.ReactNode }) {
  if (disabled) return <span className={styles.pageBtn} aria-disabled="true">{children}</span>;
  return <Link className={styles.pageBtn} href={`/matchup?week=${week}`}>{children}</Link>;
}

function Scoreboard({ team, opponent, score, upcoming }: {
  team: MatchupSide; opponent: MatchupSide; score: MatchupScore; upcoming: boolean;
}) {
  const sub = (s: MatchupSide) => upcoming
    ? `${plural(s.gamesLeft, "game")} this week`
    : `${plural(s.gamesPlayed, "game")} played · ${s.gamesLeft} left this week`;
  return (
    <section className={styles.board} aria-label="Score">
      <div className={styles.side}>
        <div className={styles.t}><i aria-hidden="true">{team.abbreviation}</i><h2>{team.name}</h2></div>
        <p>{sub(team)}</p>
        <Link href="/my-team">Set lineup</Link>
      </div>
      <div className={styles.score}>
        {fmtScore(score)}
        <small>Categories won · lost · tied</small>
      </div>
      <div className={`${styles.side} ${styles.r}`}>
        <div className={styles.t}><i aria-hidden="true">{opponent.abbreviation}</i><h2>{opponent.name}</h2></div>
        <p>{sub(opponent)}</p>
      </div>
    </section>
  );
}

function Value({ k, line, result, right }: { k: CategoryKey; line: CategoryLine; result: CategoryResult; right?: boolean }) {
  const cls = [styles.v, right && styles.vr, result === "win" && styles.w].filter(Boolean).join(" ");
  const shots = k === "fgPct" ? `${line.fgm}/${line.fga}` : k === "ftPct" ? `${line.ftm}/${line.fta}` : null;
  const main = k === "fgPct" || k === "ftPct" ? fmtPct(line[k]) : fmtInt(line[k]);
  return (
    <span className={cls}>
      {right && shots && <small>{shots}</small>}
      {main}
      {!right && shots && <small>{shots}</small>}
    </span>
  );
}

function Categories({ team, opponent, results }: {
  team: MatchupSide; opponent: MatchupSide; results: Record<CategoryKey, CategoryResult>;
}) {
  return (
    <section className={styles.card}>
      <h3>Categories</h3>
      <div className={styles.grid} role="table" aria-label="Categories">
        <div className={`${styles.c} ${styles.h}`} role="row">
          <span role="columnheader">Cat</span>
          <span role="columnheader" className={styles.name}>{team.name}</span>
          <span role="columnheader"><span className={styles.sr}>Result</span></span>
          <span role="columnheader" className={`${styles.name} ${styles.right}`}>{opponent.name}</span>
        </div>
        {CATEGORY_KEYS.map((k) => (
          <div className={styles.c} role="row" key={k}>
            <span role="rowheader" className={styles.cat}>
              {LABELS[k]}
              {k === "tov" && <small>lower wins</small>}
            </span>
            <span role="cell"><Value k={k} line={team.stats} result={results[k]} /></span>
            <span role="cell" className={`${styles.res} ${styles[results[k]]}`}>{RESULT_LABEL[results[k]]}</span>
            <span role="cell"><Value k={k} line={opponent.stats} result={FLIP[results[k]]} right /></span>
          </div>
        ))}
      </div>
      <p className={`${styles.foot} ${styles.footTop}`}>
        Week totals. FG% and FT% are total makes over total attempts for the week.
      </p>
    </section>
  );
}

function GamesLeft({ data, team, opponent }: { data: MatchupWeek; team: MatchupSide; opponent: MatchupSide }) {
  const max = Math.max(team.gamesLeft, opponent.gamesLeft);
  const width = (n: number) => `${max > 0 ? Math.round((n / max) * 100) : 0}%`;
  const idle = data.idleStarters;
  const names = idle.map((p) => `${p.firstName} ${p.lastName}`).join(", ");
  return (
    <section className={styles.card}>
      <h3>Games left this week</h3>
      <div className={styles.gl}>
        {[team, opponent].map((s, i) => (
          <div className={styles.gr} key={s.id}>
            <div className={styles.top}>{s.name}<span>{plural(s.gamesLeft, "game")}</span></div>
            <div className={styles.track}>
              <div className={`${styles.fill} ${i === 1 ? styles.o : ""}`} style={{ width: width(s.gamesLeft) }} />
            </div>
          </div>
        ))}
      </div>
      <p className={styles.foot}>
        Starter games only.
        {idle.length === 1 && ` One starter (${names}) sits idle today.`}
        {idle.length > 1 && ` ${idle.length} starters (${names}) sit idle today.`}
      </p>
      {idle.length > 0 && <Link className={styles.lk} href="/my-team">Fix today’s lineup</Link>}
    </section>
  );
}

function AroundTheLeague({ data }: { data: MatchupWeek }) {
  if (data.others.length === 0) return null;
  return (
    <section className={styles.card}>
      <h3>Around the league</h3>
      {data.others.map((o) => (
        <div className={styles.other} key={o.teamA.id}>
          <span>{o.teamA.name}</span>
          <b>{o.teamB ? fmtScore(o.score) : "Bye"}</b>
          <span>{o.teamB?.name ?? ""}</span>
        </div>
      ))}
    </section>
  );
}

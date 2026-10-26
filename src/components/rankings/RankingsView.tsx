// The /rankings page: docs/design/rankings.mockup.html. The stack rank orders
// every team by its all-play record (each team against all the others) for one
// week or the season, showing the nine category totals shaded by their rank.
// Versus the league shows one team (yours by default) against each other team;
// picking a team in the stack rank focuses it.
import Link from "next/link";
import type { CategoryKey, CategoryLine, MatchupScore, RankingsPeriod, RankingsView as View } from "@/lib/types";
import { CATEGORY_KEYS } from "@/lib/types";
import SiteHeader from "@/components/SiteHeader";
import TeamBadge from "@/components/TeamBadge";
import { fmtGameDate, fmtInt, fmtPct } from "@/components/players/format";
import styles from "./RankingsView.module.css";

const CATEGORY_LABELS: Record<CategoryKey, string> = {
  fgPct: "FG%", ftPct: "FT%", fg3m: "3PM", pts: "PTS", reb: "REB", ast: "AST", stl: "STL", blk: "BLK", tov: "TO",
};

const RESULT_WORDS = { win: "won", loss: "lost", tie: "tied" } as const;

/** "Oct 20–25", or "Oct 27 – Nov 2" across months. */
function fmtRange(from: string, to: string): string {
  const a = fmtGameDate(from);
  const b = fmtGameDate(to);
  return a.slice(0, 3) === b.slice(0, 3) ? `${a}–${b.slice(4)}` : `${a} – ${b}`;
}

/** 1st, 2nd, 3rd, 11th */
function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

const fmtStat = (line: CategoryLine, key: CategoryKey) =>
  key === "fgPct" || key === "ftPct" ? fmtPct(line[key]) : fmtInt(line[key]);

/** 6–3, or 5–3–1 with ties. */
const fmtScore = (s: MatchupScore) => `${s.wins}–${s.losses}${s.ties ? `–${s.ties}` : ""}`;

/** The shading for a category place: top quarter of the league, second, third, bottom. */
const tierOf = (rank: number, teams: number) => Math.min(4, Math.max(1, Math.ceil((rank * 4) / teams)));

interface Where {
  period: RankingsPeriod;
  week: number | null;
  team: number | null;
}

function hrefOf(w: Where): string {
  const q = new URLSearchParams();
  if (w.period === "season") q.set("view", "season");
  else if (w.week !== null) q.set("week", String(w.week));
  if (w.team !== null) q.set("team", String(w.team));
  const s = q.toString();
  return s ? `/rankings?${s}` : "/rankings";
}

export default function RankingsView({ data, teamParam }: { data: View | null; teamParam: number | null }) {
  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <SiteHeader />
        <h1 className={styles.title}>Power rankings</h1>
        <p className={styles.sub}>
          Every team’s week against all the others, nine categories each. Ranked by the share of categories you’d have won.
        </p>
        {data ? <Rankings data={data} teamParam={teamParam} /> : <p className={styles.empty}>No league schedule for this season yet.</p>}
      </div>
    </div>
  );
}

function Rankings({ data, teamParam }: { data: View; teamParam: number | null }) {
  const here: Where = { period: data.period, week: data.week?.week ?? null, team: teamParam };
  const teams = data.rows.length;
  const isWeek = data.period === "week";
  const others = Math.max(teams - 1, 0);
  return (
    <>
      <section className={styles.card} aria-labelledby="stack-rank">
        <div className={styles.cardHead}>
          <h2 id="stack-rank">Stack rank</h2>
          <div className={styles.controls}>
            <nav className={styles.seg} aria-label="Period">
              <Link href={hrefOf({ ...here, period: "week" })} aria-current={isWeek ? "page" : undefined}>Week</Link>
              <Link href={hrefOf({ ...here, period: "season", week: null })} aria-current={isWeek ? undefined : "page"}>Season</Link>
            </nav>
            {isWeek && data.week ? <WeekPager data={data} here={here} /> : <SeasonLabel data={data} />}
          </div>
        </div>
        {teams === 0 ? (
          <p className={styles.empty}>{isWeek ? "This week hasn’t started yet." : "No regular-season weeks played yet."}</p>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.rank}>
              <thead>
                <tr>
                  <th scope="col" className={styles.pos}>#</th>
                  <th scope="col" className={styles.team}>Team</th>
                  {CATEGORY_KEYS.map((k) => <th key={k} scope="col" className={styles.num}>{CATEGORY_LABELS[k]}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr
                    key={r.id}
                    className={[r.isMine && styles.mine, r.id === data.focus?.team.id && styles.focused].filter(Boolean).join(" ") || undefined}
                  >
                    <td className={styles.pos}>{r.rank}</td>
                    <th scope="row" className={styles.team}>
                      <Link href={hrefOf({ ...here, team: r.id })} scroll={false} className={styles.teamLink}>
                        <TeamBadge team={r} className={styles.badge} />
                        <span>{r.name}</span>
                      </Link>
                    </th>
                    {CATEGORY_KEYS.map((k) => (
                      <td key={k} className={styles.num}>
                        <span className={`${styles.cv} ${styles[`t${tierOf(r.catRanks[k], teams)}`] ?? ""}`}>
                          {fmtStat(r.stats, k)}
                          <small>{ordinal(r.catRanks[k])}</small>
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={styles.foot}>
          {isWeek
            ? `Ranked by categories won against all ${others} other teams this week (ties count half). Cells are shaded by this week’s category rank: darkest is the top quarter of the league, grey the bottom.`
            : "Ranked by categories won against every other team, all weeks added up. Categories are season totals (FG% and FT% from total makes ÷ attempts), shaded by season rank."}
        </p>
      </section>

      {data.focus && <Versus data={data} focus={data.focus} />}
    </>
  );
}

function WeekPager({ data, here }: { data: View; here: Where }) {
  const w = data.week!;
  const state = w.status === "live" ? "Live" : w.status === "final" ? "Final" : "Upcoming";
  const lead = w.isPlayoffs ? "Playoffs · " : "";
  return (
    <nav className={styles.pager} aria-label="Weeks">
      <PagerLink href={hrefOf({ ...here, week: w.week - 1 })} disabled={w.week <= 1} label="Previous week">‹</PagerLink>
      <div className={styles.pagerLabel}>
        <b>Week {w.week}</b>
        <small>{lead}{fmtRange(w.startsOn, w.endsOn)} · {state}</small>
      </div>
      <PagerLink href={hrefOf({ ...here, week: w.week + 1 })} disabled={w.week >= data.weekCount} label="Next week">›</PagerLink>
    </nav>
  );
}

function PagerLink({ href, disabled, label, children }: { href: string; disabled: boolean; label: string; children: React.ReactNode }) {
  if (disabled) return <span className={styles.pageBtn} aria-disabled="true" aria-label={label}>{children}</span>;
  return <Link className={styles.pageBtn} href={href} aria-label={label}>{children}</Link>;
}

function SeasonLabel({ data }: { data: View }) {
  const n = data.weeksCounted;
  return (
    <div className={styles.pagerLabel}>
      <b>{n === 0 ? "Season" : n === 1 ? "Week 1" : `Weeks 1–${n}`}</b>
      <small>Regular season{data.includesLiveWeek ? ", this week so far" : ""}</small>
    </div>
  );
}

function Versus({ data, focus }: { data: View; focus: NonNullable<View["focus"]> }) {
  const isWeek = data.period === "week";
  const others = focus.versus.length;
  const m = focus.matchups;
  const summary = isWeek
    ? `Beats ${m.wins} of ${others}${m.ties ? `, ties ${m.ties}` : ""} · ${ordinal(focus.rank)} this week`
    : `${m.wins}–${m.losses}–${m.ties} in weeks against everyone · ${ordinal(focus.rank)} for the season`;
  const half = Math.ceil(others / 2);
  const columns = [focus.versus.slice(0, half), focus.versus.slice(half)].filter((c) => c.length > 0);
  return (
    <section className={`${styles.card} ${styles.vs}`} aria-labelledby="versus">
      <div className={styles.cardHead}>
        <h2 id="versus">Versus the league</h2>
        <span className={styles.when}>{isWeek ? `Week ${data.week!.week}` : "Season"}</span>
      </div>
      <div className={styles.focus}>
        <TeamBadge team={focus.team} className={styles.focusBadge} />
        <div>
          <b>{focus.team.name}</b>
          <small>{summary}</small>
        </div>
      </div>
      <div className={styles.cols}>
        {columns.map((col, i) => (
          <div key={i}>
            <div className={`${styles.vr} ${styles.vrHead}`} aria-hidden="true">
              <span>Opp</span>
              {isWeek ? (
                <span>
                  <span className={styles.dots}>{CATEGORY_KEYS.map((k) => <span key={k}>{CATEGORY_LABELS[k]}</span>)}</span>
                  <span className={styles.catsLabel}>Categories</span>
                </span>
              ) : (
                <span>Weeks won · tied · lost</span>
              )}
              <span className={styles.num}>{isWeek ? "Score" : "W–L–T"}</span>
            </div>
            {col.map((v) => (
              <div key={v.opponent.id} className={styles.vr}>
                <span className={styles.opp}>
                  <TeamBadge team={v.opponent} className={styles.oppBadge} />
                  <span>
                    {v.opponent.name}
                    {v.isActual && <em>Actual matchup</em>}
                    {!isWeek && <em className={styles.cats}>{fmtScore(v.score)} categories</em>}
                  </span>
                </span>
                {isWeek && v.results ? (
                  <span
                    className={styles.dots}
                    role="img"
                    aria-label={CATEGORY_KEYS.map((k) => `${CATEGORY_LABELS[k]} ${RESULT_WORDS[v.results![k]]}`).join(", ")}
                  >
                    {CATEGORY_KEYS.map((k) => (
                      <span key={k} className={styles[v.results![k]]} title={`${CATEGORY_LABELS[k]}: ${RESULT_WORDS[v.results![k]]}`} />
                    ))}
                  </span>
                ) : (
                  <WeeksBar weeks={v.weeks!} />
                )}
                <span className={`${styles.num} ${styles.score} ${styles[resultOf(isWeek ? v.score : v.weeks!)]}`}>
                  {isWeek ? fmtScore(v.score) : `${v.weeks!.wins}–${v.weeks!.losses}–${v.weeks!.ties}`}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className={styles.legend}>
        <span><i className={styles.win} />{isWeek ? "Category won" : "Week won"}</span>
        <span><i className={styles.tie} />Tied</span>
        <span><i className={styles.loss} />Lost</span>
      </div>
      <p className={`${styles.foot} ${styles.footPlain}`}>
        Pick any team in the stack rank to see it against everyone. Follows the stack rank’s week or season.
      </p>
    </section>
  );
}

const resultOf = (s: MatchupScore) => (s.wins > s.losses ? "win" : s.wins < s.losses ? "loss" : "tie");

function WeeksBar({ weeks }: { weeks: MatchupScore }) {
  return (
    <span className={styles.bar} role="img" aria-label={`Won ${weeks.wins}, tied ${weeks.ties}, lost ${weeks.losses} weeks`}>
      {weeks.wins > 0 && <span className={styles.win} style={{ flex: weeks.wins }} />}
      {weeks.ties > 0 && <span className={styles.tie} style={{ flex: weeks.ties }} />}
      {weeks.losses > 0 && <span className={styles.loss} style={{ flex: weeks.losses }} />}
    </span>
  );
}


// The /rankings page: docs/design/rankings.mockup.html. The stack rank orders
// every team by its all-play record (each team against all the others) for one
// week or the season, showing the nine category totals shaded by their rank.
// Versus the league shows one team (yours by default) against each other team;
// picking a team's row in the stack rank focuses it (its name goes to its page).
import Link from "next/link";
import type { CategoryKey, CategoryLine, MatchupScore, RankingsPeriod, RankingsRow, RankingsView as View } from "@/lib/types";
import { CATEGORY_KEYS } from "@/lib/types";
import SiteHeader from "@/components/SiteHeader";
import TeamBadge from "@/components/TeamBadge";
import TeamLink from "@/components/TeamLink";
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

/** The power score: all-play win % doubled and rounded (0–200, 100 = an even team), e.g. .626 → 125. */
const fmtScoreValue = (pct: number) => String(Math.round(pct * 200));

/** The shading for a category place: top quarter of the league, second, third, bottom. */
const tierOf = (rank: number, teams: number) => Math.min(4, Math.max(1, Math.ceil((rank * 4) / teams)));

/** What the stack rank can be sorted by: the power rank, the team's name, games played or a category. */
export type SortKey = "rank" | "team" | "gp" | CategoryKey;
export type SortDir = "asc" | "desc";
export interface Sort { key: SortKey; dir: SortDir }

const DEFAULT_SORT: Sort = { key: "rank", dir: "asc" };

/** A column's first click: best first (fewest TO, rank 1), names A–Z, most games. */
const firstDir = (key: SortKey): SortDir => (key === "rank" || key === "team" || key === "tov" ? "asc" : "desc");

/** ?sort= and ?dir= from the URL; anything unknown is the power rank. */
export function parseSort(sort: string | undefined, dir: string | undefined): Sort {
  const keys: readonly string[] = ["rank", "team", "gp", ...CATEGORY_KEYS];
  if (!sort || !keys.includes(sort)) return DEFAULT_SORT;
  const key = sort as SortKey;
  return { key, dir: dir === "asc" || dir === "desc" ? dir : firstDir(key) };
}

/** The rows in `sort`'s order; ties (and teams without attempts, last) keep the power rank's order. */
function sortRows(rows: RankingsRow[], sort: Sort): RankingsRow[] {
  if (sort.key === "rank" && sort.dir === "asc") return rows;
  const { key } = sort;
  const sign = sort.dir === "asc" ? 1 : -1;
  const value = (r: RankingsRow): number | string | null =>
    key === "rank" ? r.rank : key === "team" ? r.name.toLowerCase() : key === "gp" ? r.gamesPlayed : r.stats[key];
  return rows
    .map((r, i) => ({ r, i, v: value(r) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : a.v === null ? 1 : -1;
      const c = typeof a.v === "string" ? a.v.localeCompare(b.v as string) : a.v - (b.v as number);
      return c !== 0 ? sign * c : a.i - b.i;
    })
    .map((x) => x.r);
}

interface Where {
  period: RankingsPeriod;
  week: number | null;
  team: number | null;
  sort: Sort;
}

function hrefOf(w: Where): string {
  const q = new URLSearchParams();
  if (w.period === "season") q.set("view", "season");
  else if (w.week !== null) q.set("week", String(w.week));
  if (w.team !== null) q.set("team", String(w.team));
  if (w.sort.key !== DEFAULT_SORT.key || w.sort.dir !== DEFAULT_SORT.dir) {
    q.set("sort", w.sort.key);
    if (w.sort.dir !== firstDir(w.sort.key)) q.set("dir", w.sort.dir);
  }
  const s = q.toString();
  return s ? `/rankings?${s}` : "/rankings";
}

export default function RankingsView({ data, teamParam, sortParam = DEFAULT_SORT }: { data: View | null; teamParam: number | null; sortParam?: Sort }) {
  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <SiteHeader />
        <h1 className={styles.title}>Power rankings</h1>
        {data ? <Rankings data={data} teamParam={teamParam} sort={sortParam} /> : <p className={styles.empty}>No league schedule for this season yet.</p>}
      </div>
    </div>
  );
}

function Rankings({ data, teamParam, sort }: { data: View; teamParam: number | null; sort: Sort }) {
  const here: Where = { period: data.period, week: data.week?.week ?? null, team: teamParam, sort };
  const rows = sortRows(data.rows, sort);
  const head = (key: SortKey, label: string, className: string | undefined, title?: string) => (
    <SortHead key={key} sortKey={key} label={label} className={className} title={title} here={here} />
  );
  const teams = data.rows.length;
  const isWeek = data.period === "week";
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
                  {head("rank", "#", styles.pos, "Power rank")}
                  {head("team", "Team", styles.team)}
                  {head("rank", "Score", `${styles.num} ${styles.score}`, "Power score: how this team does against every other team (100 = even)")}
                  {head("gp", "GP", `${styles.num} ${styles.gp}`, "Games played")}
                  {CATEGORY_KEYS.map((k) => head(k, CATEGORY_LABELS[k], styles.num))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className={[r.isMine && styles.mine, r.id === data.focus?.team.id && styles.focused].filter(Boolean).join(" ") || undefined}
                  >
                    <td className={styles.pos}>{r.rank}</td>
                    <th scope="row" className={styles.team}>
                      <span className={styles.teamCell}>
                        {/* The badge (and, through its cover, the rest of the row) picks the team for Versus the league. */}
                        <Link
                          href={hrefOf({ ...here, team: r.id })}
                          scroll={false}
                          className={styles.focusLink}
                          aria-label={`Show ${r.name} against the league`}
                        >
                          <TeamBadge team={r} className={styles.badge} />
                        </Link>
                        <TeamLink team={r} myTeamId={data.myTeam?.id} className={styles.teamName} />
                      </span>
                    </th>
                    <td className={`${styles.num} ${styles.score}`}>{fmtScoreValue(r.allPlayPct)}</td>
                    <td className={`${styles.num} ${styles.gp}`}>{fmtInt(r.gamesPlayed)}</td>
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
      </section>

      {data.focus && <Versus data={data} focus={data.focus} />}
    </>
  );
}

/** A header that sorts the stack rank: best first, then reversed on a second click. */
function SortHead({ sortKey, label, className, title, here }: {
  sortKey: SortKey; label: string; className?: string; title?: string; here: Where;
}) {
  const active = here.sort.key === sortKey;
  const dir: SortDir = active ? (here.sort.dir === "asc" ? "desc" : "asc") : firstDir(sortKey);
  // Score and # both sort by the power rank; only # shows the arrow.
  const shows = active && !(sortKey === "rank" && label !== "#");
  return (
    <th scope="col" className={className} aria-sort={shows ? (here.sort.dir === "asc" ? "ascending" : "descending") : undefined}>
      <Link
        href={hrefOf({ ...here, sort: { key: sortKey, dir } })}
        scroll={false}
        className={`${styles.sortLink} ${shows ? styles.sortActive : ""}`}
        title={title}
      >
        {label}
        <span className={styles.arrow} aria-hidden="true">{shows ? (here.sort.dir === "asc" ? "▲" : "▼") : ""}</span>
      </Link>
    </th>
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
          <b><TeamLink team={focus.team} myTeamId={data.myTeam?.id} /></b>
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
                    <TeamLink team={v.opponent} myTeamId={data.myTeam?.id} />
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


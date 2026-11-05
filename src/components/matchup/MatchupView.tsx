// The /matchup page: docs/design/matchup.mockup.html.
// While games are live and the page shows today or the live week's totals, it
// re-renders with fresh stats (LiveRefresh) and changed numbers flash (Flash).
// Projected (?view=projected) swaps every score and line for the projected week.
import Link from "next/link";
import type {
  CategoryKey,
  CategoryLine,
  CategoryResult,
  LineupGame,
  LineupSlot,
  Matchup,
  MatchupPlayer,
  MatchupScore,
  MatchupSide,
  MatchupWeek,
} from "@/lib/types";
import { CATEGORY_KEYS, STARTING_SLOTS } from "@/lib/types";
import SiteHeader from "@/components/SiteHeader";
import Avatar from "@/components/Avatar";
import PlayerModalHost, { PlayerButton } from "@/components/players/PlayerModalHost";
import { fmtGameDate, fmtInt, fmtPct, fullName, teamPos } from "@/components/players/format";
import TeamBadge from "@/components/TeamBadge";
import Flash from "@/components/live/Flash";
import LiveRefresh from "@/components/live/LiveRefresh";
import styles from "./MatchupView.module.css";

const LABELS: Record<CategoryKey, string> = {
  fgPct: "FG%", ftPct: "FT%", fg3m: "3PM", pts: "PTS", reb: "REB", ast: "AST", stl: "STL", blk: "BLK", tov: "TO",
};

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
  // "Playoffs · Semifinal · Week 23", "Toilet bowl · Round 1 · Week 23"
  const lead = d.matchup?.bracket ? `${d.matchup.bracket.label} · ` : d.isPlayoffs ? "Playoffs · " : "";
  const parts = [`${lead}Week ${d.week}`, fmtRange(d.startsOn, d.endsOn)];
  if (d.status === "live") parts.push(`Day ${d.day} of ${d.days}`);
  else parts.push(d.status === "final" ? "Final" : "Upcoming");
  return parts.join(" · ");
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekday = (iso: string) => WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];

function weekDates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function gameText(g: LineupGame, timeZone: string): string {
  const opp = `${g.home ? "vs" : "@"} ${g.opponentAbbr}`;
  const score = g.teamScore !== null && g.opponentScore !== null ? `${g.teamScore}–${g.opponentScore}` : "";
  if (g.state === "scheduled") {
    const tip = g.tipoff
      ? new Date(g.tipoff).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone })
      : "TBD";
    return `${opp} · ${tip}`;
  }
  if (g.state === "live") return `${opp} · ${g.statusText ?? "Live"}${score ? ` · ${score}` : ""}`;
  const result = g.teamScore !== null && g.opponentScore !== null && g.teamScore !== g.opponentScore
    ? (g.teamScore > g.opponentScore ? "W " : "L ") : "";
  return `${opp} · ${result}${score || "Final"}`;
}

/** Summed lines; FG%/FT% from summed makes / attempts. */
function sumLines(lines: CategoryLine[]): CategoryLine {
  const t = { fgm: 0, fga: 0, ftm: 0, fta: 0, fg3m: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0 };
  for (const l of lines) for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += l[k];
  const pct = (m: number, a: number) => (a > 0 ? m / a : null);
  return { ...t, fgPct: pct(t.fgm, t.fga), ftPct: pct(t.ftm, t.fta) };
}

/** Where a link goes: the week, whose matchup (null = yours), whose stats (null = the default), and projected or not. */
interface View {
  week: number;
  team: number | null;
  stats: string | null;
  projected: boolean;
}

function viewHref(v: View): string {
  const q = new URLSearchParams({ week: String(v.week) });
  if (v.team !== null) q.set("team", String(v.team));
  if (v.projected) q.set("view", "projected");
  else if (v.stats !== null) q.set("stats", v.stats);
  return `/matchup?${q}`;
}

export default function MatchupView({ data, signedIn }: { data: MatchupWeek | null; signedIn: boolean }) {
  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <SiteHeader />
        <PlayerModalHost>
          {data ? (
            // Keyed by what's shown, so moving to another week, team or day remounts
            // the cells instead of flashing them all.
            <Week
              key={`${data.week}:${data.matchup?.team.id ?? ""}:${data.projected ? "projected" : data.statsDate ?? "week"}`}
              data={data}
              signedIn={signedIn}
            />
          ) : (
            <p className={styles.empty}>No league schedule for this season yet.</p>
          )}
        </PlayerModalHost>
      </div>
    </div>
  );
}

function Week({ data, signedIn }: { data: MatchupWeek; signedIn: boolean }) {
  const { matchup: m } = data;
  const view: View = {
    week: data.week,
    team: m && !m.isMine ? m.team.id : null,
    stats: data.statsDate ?? "week",
    projected: data.projected,
  };
  const live = data.live && data.status === "live" && (data.statsDate === null || data.statsDate === data.today);
  return (
    <>
      <LiveRefresh active={live} />
      <div className={styles.wk}>
        <h1>{weekTitle(data)}</h1>
        <div className={styles.wkTools}>
          <ProjectionToggle view={view} />
          <nav className={styles.pager} aria-label="Weeks">
            <PagerLink href={viewHref({ ...view, week: data.week - 1, stats: null })} disabled={data.week <= 1}>
              Previous week
            </PagerLink>
            <PagerLink href={viewHref({ ...view, week: data.week + 1, stats: null })} disabled={data.week >= data.weekCount}>
              Next week
            </PagerLink>
          </nav>
        </div>
      </div>

      {m && <Scoreboard m={m} projected={data.projected} />}
      <div className={styles.top}>
        {m ? <Categories m={m} projected={data.projected} /> : (
          <div className={`${styles.card} ${styles.notice}`}>
            {!signedIn ? (
              <p>Sign in to see your matchup, or pick one from around the league.</p>
            ) : !data.myTeam ? (
              <p>You don’t have a team in this league. Pick a matchup from around the league.</p>
            ) : (
              <p>{data.myTeam.name} has no matchup this week.</p>
            )}
          </div>
        )}
        <AroundTheLeague data={data} view={view} />
      </div>
      {m && (
        <>
          {!data.projected && <DayPicker data={data} view={view} />}
          <div className={styles.ros}>
            <Roster side={m.team} data={data} />
            <Roster side={m.opponent} data={data} />
          </div>
          <p className={styles.note}>
            {data.projected
              ? "Projected: the week so far plus each starter’s remaining games at his last-30-day average (season average with fewer than 5 games in that span), on the lineups as set. Benched days and players listed Out add nothing. Slots are today’s lineup."
              : data.statsDate
                ? "Bench and IL rows are greyed out: their games don’t count."
                : "Week totals count only the days each player started. Slots are today’s lineup."}
          </p>
        </>
      )}
    </>
  );
}

/** Actual / Projected: one pill, like SegmentedToggle, but links (the page is server-rendered). */
function ProjectionToggle({ view }: { view: View }) {
  const options = [
    { projected: false, label: "Actual" },
    { projected: true, label: "Projected" },
  ];
  return (
    <nav className={styles.toggle} aria-label="Totals">
      {options.map((o) => (
        <Link
          key={o.label}
          className={styles.segment}
          // Back to Actual opens on the default stats (today while live).
          href={viewHref({ ...view, projected: o.projected, stats: null })}
          scroll={false}
          aria-current={o.projected === view.projected ? "page" : undefined}
        >
          {o.label}
        </Link>
      ))}
    </nav>
  );
}

function PagerLink({ href, disabled, children }: { href: string; disabled: boolean; children: React.ReactNode }) {
  if (disabled) return <span className={styles.pageBtn} aria-disabled="true">{children}</span>;
  return <Link className={styles.pageBtn} href={href}>{children}</Link>;
}

function Scoreboard({ m, projected }: { m: Matchup; projected: boolean }) {
  const score = projected ? m.projectedScore : m.score;
  const sub = (s: MatchupSide) =>
    `${s.managerName ? `${s.managerName} · ` : ""}${s.gamesPlayed}/${s.gamesPlayed + s.gamesLeft} games played${s.gameLimit ? ` (limit ${s.gameLimit})` : ""}`;
  return (
    <section className={styles.board} aria-label="Score">
      <div className={styles.side}>
        <div className={styles.t}><TeamBadge team={m.team} /><h2>{m.team.name}</h2></div>
        <p>{sub(m.team)}</p>
        {m.isMine && <Link href="/my-team">Set lineup</Link>}
      </div>
      <div className={styles.scoreBox}>
        <Flash
          as="div"
          className={styles.score}
          value={fmtScore(score)}
          aria-label={`${projected ? "Projected categories" : "Categories"} won, lost, tied: ${fmtScore(score)}`}
        >
          {fmtScore(score)}
        </Flash>
        {projected && <span className={styles.scoreTag} aria-hidden="true">Projected</span>}
      </div>
      <div className={`${styles.side} ${styles.r}`}>
        <div className={styles.t}><TeamBadge team={m.opponent} /><h2>{m.opponent.name}</h2></div>
        <p>{sub(m.opponent)}</p>
      </div>
    </section>
  );
}

/** A category value; percentages show makes/attempts below. */
function Stat({ k, line }: { k: CategoryKey; line: CategoryLine }) {
  if (k === "fgPct" || k === "ftPct") {
    const [m, a] = k === "fgPct" ? [line.fgm, line.fga] : [line.ftm, line.fta];
    return <>{fmtPct(line[k])}<small>{m}/{a}</small></>;
  }
  return <>{fmtInt(line[k])}</>;
}

/** What a Stat cell shows, for spotting changes. */
function statValue(k: CategoryKey, line: CategoryLine): string {
  return k === "fgPct" ? `${line.fgm}/${line.fga}` : k === "ftPct" ? `${line.ftm}/${line.fta}` : String(line[k]);
}

function Categories({ m, projected }: { m: Matchup; projected: boolean }) {
  const results = projected ? m.projectedResults : m.results;
  const rows = [
    { side: m.team, line: projected ? m.team.projected : m.team.stats, results },
    {
      side: m.opponent,
      line: projected ? m.opponent.projected : m.opponent.stats,
      results: Object.fromEntries(CATEGORY_KEYS.map((k) => [k, FLIP[results[k]]])) as Record<CategoryKey, CategoryResult>,
    },
  ];
  return (
    <section className={styles.card}>
      <h3>Categories{projected && <span className={styles.h3Tag}>Projected</span>}</h3>
      <div role="table" aria-label="Categories">
        <div className={`${styles.cs} ${styles.csHead}`} role="row">
          <span role="columnheader">Team</span>
          {CATEGORY_KEYS.map((k) => <span role="columnheader" className={styles.n} key={k}>{LABELS[k]}</span>)}
        </div>
        {rows.map(({ side, line, results }) => (
          <div className={`${styles.cs} ${styles.csRow}`} role="row" key={side.id}>
            <span role="rowheader" className={styles.tn}>{side.name}</span>
            {CATEGORY_KEYS.map((k) => (
              <Flash role="cell" key={k} className={`${styles.n} ${results[k] === "win" ? styles.lead : ""}`} value={statValue(k, line)}>
                <Stat k={k} line={line} />
                {results[k] === "win" && <span className={styles.sr}> (leads)</span>}
              </Flash>
            ))}
          </div>
        ))}
      </div>
      <p className={styles.foot}>
        {projected
          ? "Projected week totals: games so far plus starters’ remaining games at their recent averages. "
          : "Week totals from starters. "}
        FG% and FT% are total makes over total attempts. Fewer turnovers wins TO.
      </p>
    </section>
  );
}

function AroundTheLeague({ data, view }: { data: MatchupWeek; view: View }) {
  if (data.others.length === 0) return null;
  return (
    <section className={styles.card}>
      <h3>Around the league{data.projected && <span className={styles.h3Tag}>Projected</span>}</h3>
      {data.others.map((o) => {
        const score = data.projected ? o.projectedScore ?? o.score : o.score;
        const body = (
          <>
            {o.bracket && <small className={styles.otherTag}>{o.bracket.label}</small>}
            <span>{o.teamA.name}</span>
            <Flash as="b" value={o.teamB ? fmtScore(score) : null}>{o.teamB ? fmtScore(score) : "Bye"}</Flash>
            <span>{o.teamB?.name ?? ""}</span>
          </>
        );
        if (!o.teamB) return <div className={styles.other} key={o.teamA.id}>{body}</div>;
        return (
          <Link
            className={`${styles.other} ${styles.otherLink} ${o.isMine ? styles.otherMine : ""}`}
            key={o.teamA.id}
            href={viewHref({ ...view, team: o.isMine ? null : o.teamA.id })}
            scroll={false}
            aria-label={`${o.teamA.name} ${fmtScore(score)} ${o.teamB.name}${data.projected ? " (projected)" : ""}${o.isMine ? " (your matchup)" : ""}`}
          >
            {body}
          </Link>
        );
      })}
    </section>
  );
}

function DayPicker({ data, view }: { data: MatchupWeek; view: View }) {
  const chips = [
    { stats: "week", label: "Week", sub: "Totals", on: data.statsDate === null },
    ...weekDates(data.startsOn, data.endsOn).map((d) => ({
      stats: d,
      label: d === data.today ? "Today" : weekday(d),
      sub: fmtGameDate(d),
      on: data.statsDate === d,
    })),
  ];
  return (
    <nav className={styles.days} aria-label="Roster stats">
      <span className={styles.daysLabel}>Stats</span>
      {chips.map((c) => (
        <Link
          key={c.stats}
          className={`${styles.day} ${c.on ? styles.dayOn : ""}`}
          href={viewHref({ ...view, stats: c.stats })}
          scroll={false}
          aria-current={c.on ? "page" : undefined}
        >
          {c.label}
          <small>{c.sub}</small>
        </Link>
      ))}
    </nav>
  );
}

const isStarter = (p: MatchupPlayer) => p.slot !== null && STARTING_SLOTS.includes(p.slot);

function Roster({ side, data }: { side: MatchupSide; data: MatchupWeek }) {
  const day = data.statsDate;
  const total = data.projected
    ? side.projected
    : day
      ? sumLines(side.players.filter((p) => isStarter(p) && p.stats && p.stats.min > 0).map((p) => p.stats!))
      : side.stats;
  const hint = data.projected
    ? "Projected week"
    : day ? (day === data.today ? "Today" : `${weekday(day)}, ${fmtGameDate(day)}`) : "Week totals";
  return (
    <section className={styles.card}>
      <h3 className={styles.rosH}>{side.name}<span>{hint}</span></h3>
      <div role="table" aria-label={`${side.name} roster`}>
        <div className={`${styles.g} ${styles.gHead}`} role="row">
          <span role="columnheader">Slot</span>
          <span role="columnheader">Player</span>
          {CATEGORY_KEYS.map((k) => <span role="columnheader" className={styles.n} key={k}>{LABELS[k]}</span>)}
        </div>
        {rosterRows(side.players, data).map((r) => r.player
          ? <PlayerRow key={r.player.id} p={r.player} day={day !== null} projected={data.projected} timeZone={data.timeZone} />
          : <EmptyRow key={r.key} slot={r.slot} />)}
        <div className={`${styles.g} ${styles.gTotal}`} role="row">
          <span role="cell" />
          <span role="rowheader">{data.projected ? "Projected" : day ? "Starters" : "Week"}</span>
          {CATEGORY_KEYS.map((k) => (
            <Flash role="cell" className={styles.n} key={k} value={statValue(k, total)}><Stat k={k} line={total} /></Flash>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Players in slot order, with an empty row for each open starting slot so both rosters line up. */
function rosterRows(players: MatchupPlayer[], data: MatchupWeek) {
  const rows: { key: string; slot: LineupSlot; player: MatchupPlayer | null }[] = [];
  for (const { slot, count } of data.slots.filter((s) => STARTING_SLOTS.includes(s.slot))) {
    const held = players.filter((p) => p.slot === slot);
    for (let i = 0; i < Math.max(count, held.length); i++) {
      rows.push({ key: `${slot}${i}`, slot, player: held[i] ?? null });
    }
  }
  return [
    ...rows,
    ...players.filter((p) => !isStarter(p)).map((p) => ({ key: String(p.id), slot: p.slot ?? "BN", player: p })),
  ];
}

function EmptyRow({ slot }: { slot: LineupSlot }) {
  return (
    <div className={`${styles.g} ${styles.gRow}`} role="row">
      <span role="cell"><span className={styles.slot}>{slot}</span></span>
      <span role="cell" className={`${styles.pl} ${styles.open}`}>Empty</span>
      {CATEGORY_KEYS.map((k) => <span role="cell" key={k} />)}
    </div>
  );
}

function PlayerRow({ p, day, projected, timeZone }: { p: MatchupPlayer; day: boolean; projected: boolean; timeZone: string }) {
  const line = projected ? p.projected : p.stats;
  const dim = day && !isStarter(p);
  let sub: string;
  let idle = false;
  if (day) {
    sub = p.game ? gameText(p.game, timeZone) : "No game";
    idle = p.game === null && isStarter(p);
  } else if (projected) {
    const played = p.stats?.gp ?? 0;
    sub = `${played} GP · ${(p.projected?.gp ?? 0) - played} left${p.slot === null ? " · Left roster" : ""}`;
  } else {
    sub = `${p.stats?.gp ?? 0} GP${p.slot === null ? " · Left roster" : ""}`;
  }
  const dnp = day && p.stats !== null && p.stats.min === 0;
  // A starter whose game is on right now (day view only: week totals have no game),
  // unless he's listed Out and hasn't played: the report can be stale, minutes aren't.
  const live = p.game?.state === "live" && isStarter(p) && (p.injury?.status !== "Out" || (p.stats?.min ?? 0) > 0);
  return (
    <div className={`${styles.g} ${styles.gRow} ${dim ? styles.dim : ""} ${live ? styles.liveRow : ""}`} role="row">
      <span role="cell"><span className={styles.slot}>{p.slot ?? "—"}</span></span>
      <span role="cell" className={styles.pl}>
        <PlayerButton playerId={p.id}>
          <Avatar player={p} size={28} />
          <span className={styles.plText}>
            <b data-player-name>{fullName(p)}</b>
            <span className={idle ? styles.idle : undefined}>{teamPos(p.teamAbbr, p.position)} · {sub}</span>
          </span>
        </PlayerButton>
      </span>
      {dnp ? (
        <span role="cell" className={styles.dnp}>DNP</span>
      ) : (
        CATEGORY_KEYS.map((k) => (
          <Flash role="cell" className={styles.n} key={k} value={line && statValue(k, line)}>
            {line && <Stat k={k} line={line} />}
          </Flash>
        ))
      )}
    </div>
  );
}

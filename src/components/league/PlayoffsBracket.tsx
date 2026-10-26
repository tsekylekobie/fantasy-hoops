// The Standings card's Playoffs view: the playoff bracket and the toilet bowl,
// projected from today's standings until the real rounds exist (rules in
// src/lib/playoffs/bracket.ts). Rounds run left to right and scroll sideways
// inside the card on narrow screens. A real game opens its matchup.
import Link from "next/link";
import type { Bracket, BracketGame, BracketTeam, FantasyTeamSummary, MatchupScore, PlayoffsView } from "@/lib/types";
import { fmtGameDate } from "@/components/players/format";
import TeamBadge from "@/components/TeamBadge";
import styles from "./PlayoffsBracket.module.css";

const fmtScore = (s: MatchupScore) => `${s.wins}–${s.losses}–${s.ties}`;

/** "Mar 22–28", or "Mar 29 – Apr 4" across months. */
function fmtRange(from: string, to: string): string {
  const a = fmtGameDate(from);
  const b = fmtGameDate(to);
  return a.slice(0, 3) === b.slice(0, 3) ? `${a}–${b.slice(4)}` : `${a} – ${b}`;
}

/** What fills a side that isn't decided yet: the feeder game's advancing team, or "Winner of 1v8". */
type Side = { team: BracketTeam } | { text: string };

function feederSide(b: Bracket, round: number, slot: number): Side {
  const prev = b.rounds[round - 2]?.games[slot];
  if (!prev) return { text: "TBD" };
  const adv = [prev.a, prev.b].find((t) => t !== null && t.id === prev.advancesId);
  if (adv) return { team: adv };
  if (prev.a && prev.b) return { text: `${b.kind === "playoffs" ? "Winner" : "Loser"} of ${prev.a.seed}v${prev.b.seed}` };
  return { text: "TBD" };
}

/** "Seeds 9–12", from round 1's teams. */
function seedRange(b: Bracket): string {
  const seeds = (b.rounds[0]?.games ?? []).flatMap((g) => [g.a?.seed ?? 0, g.b?.seed ?? 0]).filter((s) => s > 0);
  return seeds.length ? `Seeds ${Math.min(...seeds)}–${Math.max(...seeds)}` : `${b.teams} teams`;
}

export default function PlayoffsBracket({ data, myTeam }: { data: PlayoffsView; myTeam: FantasyTeamSummary | null }) {
  return (
    <div className={styles.wrap}>
      {data.projected && <p className={styles.note}>If the season ended today</p>}
      <h4 className={styles.sub}>Playoffs <span>{seedRange(data.playoffs)} · winner advances</span></h4>
      <BracketGrid b={data.playoffs} columns={data.playoffs.rounds.length} myTeam={myTeam} />
      {data.toiletBowl && (
        <>
          <h4 className={styles.sub}>Toilet bowl <span>{seedRange(data.toiletBowl)} · loser advances</span></h4>
          <BracketGrid b={data.toiletBowl} columns={data.playoffs.rounds.length} myTeam={myTeam} />
        </>
      )}
      <p className={styles.foot}>
        {data.projected ? "Seeded from today’s standings. " : ""}
        One week per round; a tied matchup goes to the better seed.
        {data.toiletBowl && " In the toilet bowl the loser advances, and the loser of its final finishes last."}
      </p>
    </div>
  );
}

/**
 * One bracket, a column per round. `columns` is the playoffs' round count: the
 * toilet bowl ends with the playoff final, so its rounds line up under the
 * same weeks and any week before it starts is an empty column.
 */
function BracketGrid({ b, columns, myTeam }: { b: Bracket; columns: number; myTeam: FantasyTeamSummary | null }) {
  if (b.rounds.length === 0) return null;
  const off = Math.max(0, columns - b.rounds.length);
  const firstWeek = b.rounds[0].week?.week;
  return (
    <div className={styles.scroll}>
      <div className={styles.grid}>
        {Array.from({ length: off }, (_, i) => (
          <div key={`off${i}`} className={`${styles.round} ${styles.off}`}>
            <div className={styles.rh}>
              <b>Off week</b>
              {firstWeek !== undefined && <span>Week {firstWeek - off + i}</span>}
            </div>
            <div className={styles.slots}><div className={styles.slot}><span className={styles.tbd}>No game</span></div></div>
          </div>
        ))}
        {b.rounds.map((r, i) => {
          const last = i === b.rounds.length - 1;
          return (
            <div key={r.round} className={`${styles.round} ${last ? styles.last : ""}`}>
              <div className={styles.rh}>
                <b>{r.name}</b>
                {r.week && <span>Week {r.week.week} · {fmtRange(r.week.startsOn, r.week.endsOn)}</span>}
              </div>
              <div className={styles.slots}>
                {r.games.map((g) => (
                  <div key={g.slot} className={styles.slot}>
                    <Game b={b} round={r.round} g={g} week={r.week?.week ?? null} myTeam={myTeam} />
                    {last && <Result b={b} />}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Champion or last place, under the final. */
function Result({ b }: { b: Bracket }) {
  return (
    <div className={`${styles.trophy} ${b.result ? styles.decided : ""} ${b.kind === "toilet_bowl" ? styles.flush : ""}`}>
      <b>{b.kind === "playoffs" ? "Champion" : "Last place"}</b>
      {b.result ? (
        <span className={styles.champ}>
          <TeamBadge team={b.result} />
          <span>{b.result.name}</span>
        </span>
      ) : (
        <span className={styles.tbd}>TBD</span>
      )}
    </div>
  );
}

function Game({
  b, round, g, week, myTeam,
}: { b: Bracket; round: number; g: BracketGame; week: number | null; myTeam: FantasyTeamSummary | null }) {
  const a: Side = g.a ? { team: g.a } : feederSide(b, round, g.slot * 2);
  const bSide: Side | null = g.bye ? null : g.b ? { team: g.b } : feederSide(b, round, g.slot * 2 + 1);
  const final = g.status === "final";
  const row = (side: Side | null, wins: number | null) => {
    if (side === null) {
      return <div className={`${styles.team} ${styles.bye}`}><span className={styles.seed} /><span className={styles.tbd}>Bye</span></div>;
    }
    if ("text" in side) {
      return <div className={styles.team}><span className={styles.seed} /><span className={styles.tbd}>{side.text}</span></div>;
    }
    const t = side.team;
    const state = final && !g.bye ? (t.id === g.winnerId ? styles.won : styles.lost) : "";
    const moves = final && t.id === g.advancesId && b.kind === "toilet_bowl" && !g.bye;
    return (
      <div className={[styles.team, state, t.isMine && styles.mine].filter(Boolean).join(" ")}>
        <span className={styles.seed}>{t.seed}</span>
        <TeamBadge team={t} />
        <span className={styles.name}>
          <span>{t.name}</span>
          <small>{fmtScore(t.record)}{moves ? (round === b.rounds.length ? " · last place" : " · advances") : ""}</small>
        </span>
        {wins !== null && <b className={styles.score}>{wins}</b>}
      </div>
    );
  };
  const body = (
    <>
      {row(a, g.score ? g.score.wins : null)}
      {row(bSide, g.score ? g.score.losses : null)}
      {g.status === "live" && <span className={styles.live}>Live</span>}
    </>
  );
  const mine = g.a?.isMine || g.b?.isMine;
  if (!g.a || !g.b || week === null) return <div className={`${styles.game} ${mine ? styles.gameMine : ""}`}>{body}</div>;
  // Like the scoreboard: your matchup opens on its own, others by team.
  const href = mine && myTeam ? `/matchup?week=${week}` : `/matchup?week=${week}&team=${g.a.id}`;
  return (
    <Link
      href={href}
      className={`${styles.game} ${styles.link} ${mine ? styles.gameMine : ""}`}
      aria-label={`${g.a.name} vs ${g.b.name}${g.score ? `, ${fmtScore(g.score)}` : ""}`}
    >
      {body}
    </Link>
  );
}

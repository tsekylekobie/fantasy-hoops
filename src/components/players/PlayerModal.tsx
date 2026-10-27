"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Avatar from "@/components/Avatar";
import type { PlayerDetailResponse, PlayerNewsItem, PlayerNewsResponse, PlayerWeek, SeasonRow } from "@/lib/types";
import { CURRENT_SEASON, seasonLabel } from "@/lib/types";
import { fetchJson, fmtAvg, fmtGameDate, fmtInt, fmtOpponent, fmtPct, fmtInjuryLine, fmtWaiverTime, fullName } from "./format";
import styles from "./PlayerModal.module.css";

interface Props {
  /** The player to show; null keeps the dialog closed. */
  playerId: number | null;
  onClose: () => void;
  /** Free agents get an Add button that calls this. */
  onAdd?: (id: number) => void;
  /** The signed-in manager's team, to say "On your team". */
  myTeamId?: number | null;
  /** Bump to refetch (e.g. after an add changed his owner). */
  refreshKey?: number;
}

type Load =
  | { status: "idle" }
  | { status: "loading"; id: number }
  | { status: "ready"; id: number; data: PlayerDetailResponse }
  | { status: "error"; id: number; message: string };

export default function PlayerModal({ playerId, onClose, onAdd, myTeamId = null, refreshKey = 0 }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const closingFromProp = useRef(false);
  const [load, setLoad] = useState<Load>({ status: "idle" });
  const [retryKey, setRetryKey] = useState(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Open/close the native dialog to follow playerId.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (playerId !== null && !dialog.open) {
      const active = document.activeElement;
      triggerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      dialog.showModal();
      document.documentElement.classList.add(styles.scrollLocked);
    } else if (playerId === null && dialog.open) {
      closingFromProp.current = true;
      dialog.close();
    }
  }, [playerId]);

  // Any close (ours above, or one the browser forces, e.g. a repeated Esc):
  // restore page state, and sync the URL if the browser closed it on its own.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleClose = () => {
      if (!closingFromProp.current) onCloseRef.current();
      closingFromProp.current = false;
      document.documentElement.classList.remove(styles.scrollLocked);
      const trigger = triggerRef.current;
      triggerRef.current = null;
      if (trigger?.isConnected) trigger.focus();
    };
    dialog.addEventListener("close", handleClose);
    return () => {
      dialog.removeEventListener("close", handleClose);
      document.documentElement.classList.remove(styles.scrollLocked);
    };
  }, []);

  // Fetch the player whenever the id changes.
  useEffect(() => {
    if (playerId === null) return;
    const ctrl = new AbortController();
    // A refresh keeps the loaded player on screen until the new data arrives.
    setLoad((prev) => (prev.status === "ready" && prev.id === playerId ? prev : { status: "loading", id: playerId }));
    fetchJson<PlayerDetailResponse>(`/api/players/${playerId}?season=${CURRENT_SEASON}`, ctrl.signal)
      .then((data) => setLoad({ status: "ready", id: playerId, data }))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setLoad({ status: "error", id: playerId, message: err instanceof Error ? err.message : "Something went wrong." });
      });
    return () => ctrl.abort();
  }, [playerId, retryKey, refreshKey]);

  const requestClose = () => onCloseRef.current();

  const current = load.status !== "idle" && load.id === playerId ? load : null;
  const data = current?.status === "ready" ? current.data : null;

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="player-modal-title"
      onCancel={(e) => {
        // Esc: let the URL drive the close so history stays in sync.
        e.preventDefault();
        requestClose();
      }}
      onClick={(e) => {
        // Clicks on the ::backdrop land on the dialog element itself.
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (!inside) requestClose();
      }}
    >
      <div className={styles.panel}>
        {/* The close button stays mounted across loading -> loaded so focus isn't lost. */}
        <div className={styles.header}>
          {data ? (
            <DetailHead data={data} onAdd={onAdd} myTeamId={myTeamId} />
          ) : (
            <div className={styles.headText}>
              <h2 id="player-modal-title" className={styles.name}>
                {current?.status === "error" ? "Couldn’t load player" : "Loading…"}
              </h2>
            </div>
          )}
          <CloseButton onClose={requestClose} />
        </div>
        {data ? (
          <Detail data={data} />
        ) : (
          <>
            <div className={styles.state} role={current?.status === "error" ? "alert" : "status"}>
              {current?.status === "error" ? (
                <>
                  <span>{current.message}</span>
                  <button type="button" className={styles.retry} onClick={() => setRetryKey((k) => k + 1)}>
                    Try again
                  </button>
                </>
              ) : (
                <span>Loading player…</span>
              )}
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M3 3l12 12M15 3L3 15" />
      </svg>
    </button>
  );
}

/** The injury news blurb: the first few lines with Read more when there's more, all of it once expanded. */
function InjuryNote({ note }: { note: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  // Whether the clamp hides anything depends on the text and the modal's width, so measure (and re-measure on resize).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [note, open]);
  return (
    <>
      <p ref={ref} className={`${styles.injuryNote} ${open ? "" : styles.clamped}`}>{note}</p>
      {(clipped || open) && (
        <button type="button" className={styles.readMore} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Show less" : "Read more"}
        </button>
      )}
    </>
  );
}

function DetailHead({
  data, onAdd, myTeamId,
}: { data: PlayerDetailResponse; onAdd?: (id: number) => void; myTeamId: number | null }) {
  const { player, owner, waiver } = data;
  const injury = player.injury;
  const injuryLine = injury ? fmtInjuryLine(injury) : "";
  const team = player.teamName ?? player.teamAbbr;
  const subline = [team, player.position, `${seasonLabel(data.season)} season`].filter(Boolean).join(" · ");
  return (
    <>
      <Avatar player={player} size={60} />
      <div className={styles.headText}>
        <h2 id="player-modal-title" className={styles.name}>
          {fullName(player)}
          {injury && (
            <span className={`${styles.chip} ${injury.status === "Out" ? styles.chipOut : styles.chipDtd}`}>{injury.status}</span>
          )}
          {owner === null && waiver && <span className={`${styles.chip} ${styles.chipWaivers}`}>On waivers</span>}
        </h2>
        <p className={styles.subline}>
          {subline}
          {owner && ` · ${owner.teamId === myTeamId ? "On your team" : `On ${owner.abbreviation}`}`}
        </p>
        {injury && (injuryLine || injury.note) && (
          <div className={styles.injury}>
            {injuryLine && <p className={styles.injuryLine}>{injuryLine}</p>}
            {injury.note && <InjuryNote key={player.id} note={injury.note} />}
          </div>
        )}
        {owner === null && waiver && (
          <p className={styles.subline}>
            {waiver.reason === "game_started"
              ? "His game has started, so he's on waivers"
              : waiver.droppedBy
                ? `Dropped by ${waiver.droppedBy.name}`
                : "Recently dropped"}{" "}
            · Clears {fmtWaiverTime(waiver.clearsAt, data.timeZone, "long")}
          </p>
        )}
      </div>
      {owner === null && onAdd && (
        <button type="button" className={`${styles.add} ${waiver ? styles.claim : ""}`} onClick={() => onAdd(player.id)}>
          {waiver ? `Claim (${fmtWaiverTime(waiver.clearsAt, data.timeZone, "date")})` : "Add"}
        </button>
      )}
    </>
  );
}

function Detail({ data }: { data: PlayerDetailResponse }) {
  const { season, seasonAverages: avg, gameLog, pastSeasons } = data;
  const label = seasonLabel(season);

  const tiles: [string, string][] = [
    ["FG%", avg ? fmtPct(avg.fgPct) : "—"],
    ["FT%", avg ? fmtPct(avg.ftPct) : "—"],
    ["3PM", avg ? fmtAvg(avg.fg3m) : "—"],
    ["PTS", avg ? fmtAvg(avg.pts) : "—"],
    ["REB", avg ? fmtAvg(avg.reb) : "—"],
    ["AST", avg ? fmtAvg(avg.ast) : "—"],
    ["STL", avg ? fmtAvg(avg.stl) : "—"],
    ["BLK", avg ? fmtAvg(avg.blk) : "—"],
    ["TO", avg ? fmtAvg(avg.tov) : "—"],
  ];

  return (
    <>
      <dl className={styles.tiles} aria-label={`${label} per-game averages`}>
        {tiles.map(([k, v]) => (
          <div key={k} className={styles.tile}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>

      {data.thisWeek && <ThisWeek week={data.thisWeek} />}

      <News playerId={data.player.id} />

      <section className={styles.section} aria-labelledby="game-log-heading">
        <h3 id="game-log-heading" className={styles.h3}>
          Game log · {label}
        </h3>
        {gameLog.length === 0 ? (
          <p className={styles.empty}>No games played this season yet.</p>
        ) : (
          <div className={styles.scroll}>
            <table className={`${styles.table} ${styles.logTable}`}>
              <colgroup>
                <col className={styles.cDate} />
                <col className={styles.cOpp} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Opp</th>
                  {["MIN", "FG", "FT", "3PM", "PTS", "REB", "AST", "STL", "BLK", "TO"].map((c) => (
                    <th key={c} scope="col" className={styles.n}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {gameLog.map((g) => (
                  <tr key={g.gameId}>
                    <td>{fmtGameDate(g.date)}</td>
                    <td>{fmtOpponent(g.opponentAbbr, g.home, g.result)}</td>
                    <td className={styles.n}>{fmtInt(g.min)}</td>
                    <td className={styles.n}>
                      {g.fgm}-{g.fga}
                    </td>
                    <td className={styles.n}>
                      {g.ftm}-{g.fta}
                    </td>
                    <td className={styles.n}>{g.fg3m}</td>
                    <td className={`${styles.n} ${styles.key}`}>{g.pts}</td>
                    <td className={styles.n}>{g.reb}</td>
                    <td className={styles.n}>{g.ast}</td>
                    <td className={styles.n}>{g.stl}</td>
                    <td className={styles.n}>{g.blk}</td>
                    <td className={styles.n}>{g.tov}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={`${styles.section} ${styles.lastSection}`} aria-labelledby="past-seasons-heading">
        <h3 id="past-seasons-heading" className={styles.h3}>
          Past seasons
        </h3>
        {pastSeasons.length === 0 ? (
          <p className={styles.empty}>No past seasons on record.</p>
        ) : (
          <div className={styles.scroll}>
            <table className={`${styles.table} ${styles.seasonTable}`}>
              <colgroup>
                <col className={styles.cSeason} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Season</th>
                  {["GP", "MIN", "FG%", "FT%", "3PM", "PTS", "REB", "AST", "STL", "BLK", "TO"].map((c) => (
                    <th key={c} scope="col" className={styles.n}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pastSeasons.map((s) => (
                  <SeasonLine key={s.season} s={s} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

const NEWS_PREVIEW = 3;

/** Latest fantasy news, loaded on its own so a slow or failed fetch never holds up the modal. */
function News({ playerId }: { playerId: number }) {
  const [items, setItems] = useState<PlayerNewsItem[] | "loading" | "error">("loading");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setItems("loading");
    setExpanded(false);
    fetchJson<PlayerNewsResponse>(`/api/players/${playerId}/news`, ctrl.signal)
      .then((body) => setItems(body.items))
      .catch(() => {
        if (!ctrl.signal.aborted) setItems("error");
      });
    return () => ctrl.abort();
  }, [playerId]);

  const shown = Array.isArray(items) ? (expanded ? items : items.slice(0, NEWS_PREVIEW)) : [];
  return (
    <section className={styles.section} aria-labelledby="news-heading" aria-busy={items === "loading"}>
      <h3 id="news-heading" className={styles.h3}>
        Latest news
      </h3>
      {items === "loading" ? (
        <p className={styles.empty}>Loading news…</p>
      ) : items === "error" ? (
        <p className={styles.empty}>News is unavailable right now.</p>
      ) : items.length === 0 ? (
        <p className={styles.empty}>No recent news.</p>
      ) : (
        <>
          <ul className={styles.news}>
            {shown.map((n) => (
              <li key={n.id} className={styles.newsItem}>
                <p className={styles.newsHeadline}>{n.headline}</p>
                {n.story && <p className={styles.newsStory}>{n.story}</p>}
                <time className={styles.newsTime} dateTime={n.published} title={new Date(n.published).toLocaleString()}>
                  {timeAgo(n.published)}
                </time>
              </li>
            ))}
          </ul>
          {items.length > NEWS_PREVIEW && (
            <button type="button" className={styles.newsMore} onClick={() => setExpanded((e) => !e)}>
              {expanded ? "Show less" : `Show ${items.length - NEWS_PREVIEW} more`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** "12m ago", "5h ago", "3d ago", then a date. */
function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h ago`;
  if (mins < 7 * 24 * 60) return `${Math.round(mins / (24 * 60))}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const GAME_STATE = { scheduled: styles.gameScheduled, live: styles.gameLive, final: styles.gameFinal };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The player's games in the current matchup week, with games remaining / games this week. */
function ThisWeek({ week }: { week: PlayerWeek }) {
  const range = `${fmtGameDate(week.startsOn)} – ${fmtGameDate(week.endsOn)}`;
  return (
    <section className={styles.section} aria-labelledby="this-week-heading">
      <div className={styles.weekHead}>
        <h3 id="this-week-heading" className={styles.h3}>
          This week · {week.isPlayoffs ? "Playoffs · " : ""}Week {week.week}
          <span className={styles.weekRange}>{range}</span>
        </h3>
        <span className={styles.weekSummary}>
          Games Remaining
          <span
            className={`${styles.gamesPill} ${styles[`games${Math.min(week.remaining, 4)}`]}`}
            title={`${week.remaining} game${week.remaining === 1 ? "" : "s"} left of ${week.total} this week`}
          >
            {week.remaining}/{week.total}
          </span>
        </span>
      </div>
      {week.games.length === 0 ? (
        <p className={styles.empty}>No games this week.</p>
      ) : (
        <div className={styles.scroll}>
          <table className={`${styles.table} ${styles.weekTable}`}>
            <colgroup>
              <col className={styles.cDate} />
              <col className={styles.cOpp} />
              <col />
              <col className={styles.cState} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Opp</th>
                <th scope="col">Time / result</th>
                <th scope="col" className={styles.n}>Status</th>
              </tr>
            </thead>
            <tbody>
              {week.games.map((g) => {
                const done = g.state !== "scheduled";
                return (
                  <tr key={g.gameId} className={done ? styles.done : undefined}>
                    <td>
                      {WEEKDAYS[new Date(`${g.date}T00:00:00Z`).getUTCDay()]} {fmtGameDate(g.date)}
                    </td>
                    <td>{g.home ? "vs" : "@"} {g.opponentAbbr}</td>
                    <td>{weekGameText(g, week.timeZone)}</td>
                    <td className={styles.n}>
                      <span className={`${styles.gameState} ${GAME_STATE[g.state]}`}>
                        {g.state === "final" ? "Done" : g.state === "live" ? "Live" : "Remaining"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Tip-off time in the league's time zone, the live status and score, or "W 112–104". */
function weekGameText(g: PlayerWeek["games"][number], timeZone: string): string {
  const score = g.teamScore !== null && g.opponentScore !== null ? `${g.teamScore}–${g.opponentScore}` : "";
  if (g.state === "scheduled") {
    return g.tipoff ? new Date(g.tipoff).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone }) : "TBD";
  }
  if (g.state === "live") return `${g.statusText ?? "Live"}${score ? ` · ${score}` : ""}`;
  const result = g.teamScore !== null && g.opponentScore !== null && g.teamScore !== g.opponentScore
    ? (g.teamScore > g.opponentScore ? "W " : "L ") : "";
  return `${result}${score || "Final"}`;
}

function SeasonLine({ s }: { s: SeasonRow }) {
  return (
    <tr>
      <td>{seasonLabel(s.season)}</td>
      <td className={styles.n}>{fmtInt(s.gp)}</td>
      <td className={styles.n}>{fmtAvg(s.min)}</td>
      <td className={styles.n}>{fmtPct(s.fgPct)}</td>
      <td className={styles.n}>{fmtPct(s.ftPct)}</td>
      <td className={styles.n}>{fmtAvg(s.fg3m)}</td>
      <td className={`${styles.n} ${styles.key}`}>{fmtAvg(s.pts)}</td>
      <td className={styles.n}>{fmtAvg(s.reb)}</td>
      <td className={styles.n}>{fmtAvg(s.ast)}</td>
      <td className={styles.n}>{fmtAvg(s.stl)}</td>
      <td className={styles.n}>{fmtAvg(s.blk)}</td>
      <td className={styles.n}>{fmtAvg(s.tov)}</td>
    </tr>
  );
}

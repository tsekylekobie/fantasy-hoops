"use client";

import { useEffect, useRef, useState } from "react";
import Avatar from "@/components/Avatar";
import type { PlayerDetailResponse, SeasonRow } from "@/lib/types";
import { CURRENT_SEASON, seasonLabel } from "@/lib/types";
import { fetchJson, fmtAvg, fmtGameDate, fmtInt, fmtOpponent, fmtPct, fullName } from "./format";
import styles from "./PlayerModal.module.css";

interface Props {
  /** The player to show; null keeps the dialog closed. */
  playerId: number | null;
  onClose: () => void;
}

type Load =
  | { status: "idle" }
  | { status: "loading"; id: number }
  | { status: "ready"; id: number; data: PlayerDetailResponse }
  | { status: "error"; id: number; message: string };

const AVAILABILITY: Record<"available" | "day-to-day" | "out", { label: string; className: string }> = {
  available: { label: "Available", className: styles.chipAvailable },
  "day-to-day": { label: "Day-to-day", className: styles.chipDtd },
  out: { label: "Out", className: styles.chipOut },
};

export default function PlayerModal({ playerId, onClose }: Props) {
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
    setLoad({ status: "loading", id: playerId });
    fetchJson<PlayerDetailResponse>(`/api/players/${playerId}?season=${CURRENT_SEASON}`, ctrl.signal)
      .then((data) => setLoad({ status: "ready", id: playerId, data }))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setLoad({ status: "error", id: playerId, message: err instanceof Error ? err.message : "Something went wrong." });
      });
    return () => ctrl.abort();
  }, [playerId, retryKey]);

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
            <DetailHead data={data} />
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

function DetailHead({ data }: { data: PlayerDetailResponse }) {
  const { player } = data;
  const chip = player.availability ? AVAILABILITY[player.availability] : null;
  const team = player.teamName ?? player.teamAbbr;
  const subline = [team, player.position, `${seasonLabel(data.season)} season`].filter(Boolean).join(" · ");
  return (
    <>
      <Avatar player={player} size={60} />
      <div className={styles.headText}>
        <h2 id="player-modal-title" className={styles.name}>
          {fullName(player)}
          {chip && <span className={`${styles.chip} ${chip.className}`}>{chip.label}</span>}
        </h2>
        <p className={styles.subline}>{subline}</p>
      </div>
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

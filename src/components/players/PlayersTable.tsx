"use client";

import type { ReactNode } from "react";
import Avatar from "@/components/Avatar";
import type { PlayerRow, PlayersResponse, StatMode } from "@/lib/types";
import { fmtAvg, fmtInt, fmtPct, fullName, teamPos } from "./format";
import styles from "./PlayersTable.module.css";

const COLUMNS = ["GP", "MIN", "FG%", "FT%", "3PM", "PTS", "REB", "AST", "STL", "BLK", "TO"] as const;

interface Props {
  data: PlayersResponse | null;
  mode: StatMode;
  status: "loading" | "ready" | "error";
  errorMessage: string | null;
  onRetry: () => void;
  onOpenPlayer: (id: number) => void;
}

export default function PlayersTable({ data, mode, status, errorMessage, onRetry, onOpenPlayer }: Props) {
  const rows = data?.players ?? [];
  // The data's own mode decides formatting, so stale rows shown while the
  // other mode loads keep their correct decimals.
  const rowMode = data?.mode ?? mode;
  const num = rowMode === "total" ? fmtInt : fmtAvg;

  let message: ReactNode = null;
  if (status === "error") {
    message = (
      <>
        <span>Couldn&rsquo;t load players. {errorMessage}</span>
        <button type="button" className={styles.retry} onClick={onRetry}>
          Try again
        </button>
      </>
    );
  } else if (!data) {
    message = <span>Loading players…</span>;
  } else if (rows.length === 0 && status === "ready") {
    message = <span>No players match</span>;
  }

  return (
    <div className={styles.card} aria-busy={status === "loading"}>
      <table className={`${styles.table} ${status === "loading" && data ? styles.stale : ""}`}>
        <colgroup>
          <col className={styles.cRank} />
          <col />
          <col className={styles.cGp} />
          <col className={styles.cMin} />
          {Array.from({ length: 9 }, (_, i) => (
            <col key={i} className={styles.cStat} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Player</th>
            {COLUMNS.map((c) => (
              <th key={c} scope="col" className={styles.n}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {message ? (
            <tr className={styles.messageRow}>
              <td colSpan={13}>
                <div className={styles.message} role={status === "error" ? "alert" : "status"}>
                  {message}
                </div>
              </td>
            </tr>
          ) : (
            rows.map((p) => <Row key={p.id} p={p} num={num} mode={rowMode} onOpen={onOpenPlayer} />)
          )}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  p,
  num,
  mode,
  onOpen,
}: {
  p: PlayerRow;
  num: (v: number) => string;
  mode: StatMode;
  onOpen: (id: number) => void;
}) {
  const s = p.stats;
  return (
    <tr>
      <td>{p.rank}</td>
      <td>
        <span className={styles.player}>
          <Avatar player={p} size={40} />
          <span className={styles.who}>
            <button type="button" className={styles.name} data-player-id={p.id} onClick={() => onOpen(p.id)}>
              {fullName(p)}
            </button>
            <span className={styles.team}>{teamPos(p.teamAbbr, p.position)}</span>
          </span>
        </span>
      </td>
      <td className={styles.n}>{fmtInt(p.gp)}</td>
      <td className={styles.n}>{mode === "total" ? fmtInt(p.min) : fmtAvg(p.min)}</td>
      <td className={styles.n}>{fmtPct(s.fgPct)}</td>
      <td className={styles.n}>{fmtPct(s.ftPct)}</td>
      <td className={styles.n}>{num(s.fg3m)}</td>
      <td className={`${styles.n} ${styles.key}`}>{num(s.pts)}</td>
      <td className={styles.n}>{num(s.reb)}</td>
      <td className={styles.n}>{num(s.ast)}</td>
      <td className={styles.n}>{num(s.stl)}</td>
      <td className={styles.n}>{num(s.blk)}</td>
      <td className={styles.n}>{num(s.tov)}</td>
    </tr>
  );
}

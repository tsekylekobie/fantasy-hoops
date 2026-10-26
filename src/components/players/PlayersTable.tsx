"use client";

import type { ReactNode } from "react";
import Avatar from "@/components/Avatar";
import type { PlayerRow, PlayersResponse, SortDir, SortKey, StatMode } from "@/lib/types";
import { fmtAvg, fmtInt, fmtPct, fmtUpcomingGame, fmtValue, fmtWaiverTime, fullName, teamPos } from "./format";
import styles from "./PlayersTable.module.css";

/** Stat columns after # and Player, each sortable by its header. */
const COLUMNS: { label: string; sort: SortKey; title?: string }[] = [
  { label: "GP", sort: "gp", title: "Games played" },
  { label: "MIN", sort: "min", title: "Minutes" },
  { label: "FG%", sort: "fgPct", title: "Field goal % (makes/attempts below)" },
  { label: "FT%", sort: "ftPct", title: "Free throw % (makes/attempts below)" },
  { label: "3PM", sort: "fg3m" },
  { label: "PTS", sort: "pts" },
  { label: "REB", sort: "reb" },
  { label: "AST", sort: "ast" },
  { label: "STL", sort: "stl" },
  { label: "BLK", sort: "blk" },
  { label: "TO", sort: "tov", title: "Turnovers (fewer is better)" },
  { label: "Value", sort: "value", title: "9CAT value: sum of the nine category z-scores" },
];

interface Props {
  data: PlayersResponse | null;
  mode: StatMode;
  sort: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  status: "loading" | "ready" | "error";
  errorMessage: string | null;
  onRetry: () => void;
  onOpenPlayer: (id: number) => void;
  /** Free agents get an Add button (Claim for players on waivers) that calls this. */
  onAddPlayer: (id: number) => void;
  /** The signed-in manager's team, whose players get a dark chip. */
  myTeamId: number | null;
}

export default function PlayersTable({
  data, mode, sort, dir, onSort, status, errorMessage, onRetry, onOpenPlayer, onAddPlayer, myTeamId,
}: Props) {
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
          <col className={styles.cPct} />
          <col className={styles.cPct} />
          {Array.from({ length: 7 }, (_, i) => (
            <col key={i} className={styles.cStat} />
          ))}
          <col className={styles.cValue} />
          <col className={styles.cOwner} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" title="9CAT rank">#</th>
            <SortHeader label="Player" sortKey="name" sort={sort} dir={dir} onSort={onSort} />
            {COLUMNS.map((c) => (
              <SortHeader key={c.sort} {...c} sortKey={c.sort} numeric sort={sort} dir={dir} onSort={onSort} />
            ))}
            <th scope="col" className={styles.n}>
              Owner
            </th>
          </tr>
        </thead>
        <tbody>
          {message ? (
            <tr className={styles.messageRow}>
              <td colSpan={COLUMNS.length + 3}>
                <div className={styles.message} role={status === "error" ? "alert" : "status"}>
                  {message}
                </div>
              </td>
            </tr>
          ) : (
            rows.map((p) => (
              <Row
                key={p.id} p={p} num={num} mode={rowMode} onOpen={onOpenPlayer} onAdd={onAddPlayer} myTeamId={myTeamId}
                timeZone={data?.timeZone ?? "America/New_York"}
              />
            ))
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
  onAdd,
  myTeamId,
  timeZone,
}: {
  p: PlayerRow;
  num: (v: number) => string;
  mode: StatMode;
  onOpen: (id: number) => void;
  onAdd: (id: number) => void;
  myTeamId: number | null;
  timeZone: string;
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
            {p.games.length > 0 && (
              <span className={styles.games}>
                {p.games.map((g) => fmtUpcomingGame(g, timeZone)).join(" · ")}
              </span>
            )}
          </span>
        </span>
      </td>
      <td className={styles.n}>{fmtInt(p.gp)}</td>
      <td className={styles.n}>{mode === "total" ? fmtInt(p.min) : fmtAvg(p.min)}</td>
      <td className={styles.n}>
        <PctCell pct={s.fgPct} made={s.fgm} att={s.fga} num={num} />
      </td>
      <td className={styles.n}>
        <PctCell pct={s.ftPct} made={s.ftm} att={s.fta} num={num} />
      </td>
      <td className={styles.n}>{num(s.fg3m)}</td>
      <td className={`${styles.n} ${styles.key}`}>{num(s.pts)}</td>
      <td className={styles.n}>{num(s.reb)}</td>
      <td className={styles.n}>{num(s.ast)}</td>
      <td className={styles.n}>{num(s.stl)}</td>
      <td className={styles.n}>{num(s.blk)}</td>
      <td className={styles.n}>{num(s.tov)}</td>
      <td className={`${styles.n} ${styles.value}`}>{fmtValue(p.value)}</td>
      <td className={`${styles.n} ${styles.own}`}>
        {p.owner === null && p.waiver ? (
          <button
            type="button"
            className={`${styles.add} ${styles.claim}`}
            aria-label={`Claim ${fullName(p)} (on waivers, clears ${fmtWaiverTime(p.waiver.clearsAt, timeZone, "long")})`}
            title={`On waivers until ${fmtWaiverTime(p.waiver.clearsAt, timeZone, "long")}`}
            onClick={() => onAdd(p.id)}
          >
            Claim ({fmtWaiverTime(p.waiver.clearsAt, timeZone, "date")})
          </button>
        ) : p.owner === null ? (
          <button type="button" className={styles.add} aria-label={`Add ${fullName(p)}`} onClick={() => onAdd(p.id)}>
            Add
          </button>
        ) : p.owner.teamId === myTeamId ? (
          <span className={styles.mine}>{p.owner.abbreviation}</span>
        ) : (
          p.owner.abbreviation
        )}
      </td>
    </tr>
  );
}

function SortHeader({
  label,
  title,
  sortKey,
  numeric = false,
  sort,
  dir,
  onSort,
}: {
  label: string;
  title?: string;
  sortKey: SortKey;
  numeric?: boolean;
  sort: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const active = sort === sortKey;
  return (
    <th
      scope="col"
      className={numeric ? styles.n : undefined}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}
    >
      <button
        type="button"
        className={`${styles.sort} ${active ? styles.sortActive : ""}`}
        title={title}
        onClick={() => onSort(sortKey)}
      >
        {label}
        <span className={styles.arrow} aria-hidden="true">
          {active ? (dir === "asc" ? "▲" : "▼") : ""}
        </span>
      </button>
    </th>
  );
}

/** ".492" with "9.8/19.9" (per game) or "693/1457" (totals) underneath, so volume is visible. */
function PctCell({ pct, made, att, num }: { pct: number | null; made: number; att: number; num: (v: number) => string }) {
  return (
    <span className={styles.pct}>
      <span>{fmtPct(pct)}</span>
      <span className={styles.volume}>
        {num(made)}/{num(att)}
      </span>
    </span>
  );
}

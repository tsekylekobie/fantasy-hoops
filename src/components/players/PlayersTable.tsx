"use client";

import type { ReactNode } from "react";
import Avatar from "@/components/Avatar";
import type { Category, PlayerRow, PlayersResponse, RankTier, SortDir, SortKey, StatMode } from "@/lib/types";
import { fmtAvg, fmtInjuryStatus, fmtInt, fmtPct, fmtUpcomingGame, fmtValue, fmtWaiverTime, fullName, teamPos, todayIn, waiverTooltip } from "./format";
import StickyHeadTable from "@/components/table/StickyHeadTable";
import ScrollName from "./ScrollName";
import TeamLink from "@/components/TeamLink";
import styles from "./PlayersTable.module.css";

/** Stat columns after #, Player and this week's games, each sortable by its header. */
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
  { label: "Value", sort: "value", title: "9CAT value: average of the nine category z-scores, weighted by your category weights. 0 is an average rostered player" },
];

const TIER_CLASS: Record<RankTier, string | undefined> = {
  top10: styles.top10, top25: styles.top25, top40: styles.top40, mid: undefined, bottom25: styles.bottom25, bottom10: styles.bottom10,
};

/** Games left this week, colored as on My team (4+ green down to 0 red). */
const WEEK_GAMES_CLASS = [styles.games0, styles.games1, styles.games2, styles.games3, styles.games4];

const TIER_LABEL: Record<RankTier, string> = {
  top10: "top 10%", top25: "top 25%", top40: "top 40%", mid: "middle", bottom25: "bottom 25%", bottom10: "bottom 10%",
};

const CELL_LABEL: Record<Category, string> = {
  fgPct: "FG%", ftPct: "FT%", fg3m: "3PM", pts: "PTS", reb: "REB", ast: "AST", stl: "STL", blk: "BLK", tov: "TO",
};

/** A category cell shaded by its tier among rostered-calibre players (as on Box scores). Value isn't shaded. */
function Shaded({
  k, tier, mode, className, children,
}: { k: Category; tier: RankTier | undefined; mode: StatMode; className?: string; children: ReactNode }) {
  return (
    <td className={`${styles.n} ${className ?? ""}`}>
      <span
        className={`${styles.c} ${tier ? TIER_CLASS[tier] ?? "" : ""}`}
        title={tier ? `${CELL_LABEL[k]}: ${TIER_LABEL[tier]} of rostered players, ${mode === "total" ? "season total" : "per game"}` : undefined}
      >
        {children}
      </span>
    </td>
  );
}

/** The shading key, shown above the table. */
export function TierKey({ mode }: { mode: StatMode }) {
  return (
    <div className={styles.key9} aria-label="Shading key">
      <span>Shaded against the ~156 players worth rostering, {mode === "total" ? "season totals" : "per game"}:</span>
      {(["top10", "top25", "top40", "mid", "bottom25", "bottom10"] as RankTier[]).map((t) => (
        <i key={t} className={TIER_CLASS[t]}>{TIER_LABEL[t][0].toUpperCase() + TIER_LABEL[t].slice(1)}</i>
      ))}
    </div>
  );
}

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
  /**
   * Free agents get an Add button (Claim for players on waivers) that calls this.
   * Null when signed out: no league to add to, and no Owner column (league data is private).
   */
  onAddPlayer: ((id: number) => void) | null;
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
    message = (
      <span>{data.scope === "watch" && data.total === 0 ? "No watched players match. Open a player and star him to watch him." : "No players match"}</span>
    );
  }

  return (
    <StickyHeadTable
      className={styles.card}
      tableClassName={`${styles.table} ${onAddPlayer ? "" : styles.noOwner} ${status === "loading" && data ? styles.stale : ""}`}
      busy={status === "loading"}
      cols={(
        <colgroup>
          <col className={styles.cRank} />
          <col />
          <col className={styles.cWeek} />
          <col className={styles.cGp} />
          <col className={styles.cMin} />
          <col className={styles.cPct} />
          <col className={styles.cPct} />
          {Array.from({ length: 7 }, (_, i) => (
            <col key={i} className={styles.cStat} />
          ))}
          <col className={styles.cValue} />
          {onAddPlayer && <col className={styles.cOwner} />}
        </colgroup>
      )}
      head={(copy) => (
        <thead>
          <tr>
            <th scope="col" title="9CAT rank">#</th>
            <SortHeader label="Player" sortKey="name" sort={sort} dir={dir} onSort={onSort} copy={copy} />
            <th scope="col" className={styles.week}>
              <abbr className={styles.abbr} title="Games remaining / total in this matchup week">Gms</abbr>
            </th>
            {COLUMNS.map((c) => (
              <SortHeader key={c.sort} {...c} sortKey={c.sort} numeric sort={sort} dir={dir} onSort={onSort} copy={copy} />
            ))}
            {onAddPlayer && (
              <th scope="col" className={styles.n}>
                Owner
              </th>
            )}
          </tr>
        </thead>
      )}
    >
      <tbody>
        {message ? (
          <tr className={styles.messageRow}>
            <td colSpan={COLUMNS.length + (onAddPlayer ? 4 : 3)}>
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
    </StickyHeadTable>
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
  onAdd: ((id: number) => void) | null;
  myTeamId: number | null;
  timeZone: string;
}) {
  const s = p.stats;
  const t = p.tiers;
  // No game in the range (found only by a name search): dashes, not zeros.
  const played = p.gp > 0;
  const stat = (v: number) => (played ? num(v) : "—");
  return (
    <tr>
      <td>{p.rank ?? "—"}</td>
      <td>
        <span className={styles.player}>
          <Avatar player={p} size={40} />
          <span className={styles.who}>
            <button type="button" className={styles.name} data-player-id={p.id} onClick={() => onOpen(p.id)}>
              <ScrollName firstName={p.firstName} lastName={p.lastName} />
            </button>
            <span className={styles.team}>
              {teamPos(p.teamAbbr, p.position)}
              {p.injury && (
                <span className={`${styles.injury} ${p.injury.status === "Out" ? styles.out : styles.dtd}`}>{fmtInjuryStatus(p.injury, todayIn(timeZone))}</span>
              )}
            </span>
            {p.games.length > 0 && (
              <span className={styles.games}>
                {p.games.map((g) => fmtUpcomingGame(g, timeZone)).join(" · ")}
              </span>
            )}
          </span>
        </span>
      </td>
      <td className={styles.week}>
        {p.weekGames ? (
          <span
            className={`${styles.weekGames} ${WEEK_GAMES_CLASS[Math.min(p.weekGames.remaining, 4)]}`}
            title={`${p.weekGames.remaining} game${p.weekGames.remaining === 1 ? "" : "s"} left of ${p.weekGames.total} this week`}
          >
            {p.weekGames.remaining}/{p.weekGames.total}
          </span>
        ) : (
          <span className={styles.none}>–</span>
        )}
      </td>
      <td className={styles.n}>{fmtInt(p.gp)}</td>
      <td className={styles.n}>{!played ? "—" : mode === "total" ? fmtInt(p.min) : fmtAvg(p.min)}</td>
      <Shaded mode={mode} k="fgPct" tier={t.fgPct}>
        {played ? <PctCell pct={s.fgPct} made={s.fgm} att={s.fga} num={num} /> : "—"}
      </Shaded>
      <Shaded mode={mode} k="ftPct" tier={t.ftPct}>
        {played ? <PctCell pct={s.ftPct} made={s.ftm} att={s.fta} num={num} /> : "—"}
      </Shaded>
      <Shaded mode={mode} k="fg3m" tier={t.fg3m}>{stat(s.fg3m)}</Shaded>
      <Shaded mode={mode} k="pts" tier={t.pts} className={styles.key}>{stat(s.pts)}</Shaded>
      <Shaded mode={mode} k="reb" tier={t.reb}>{stat(s.reb)}</Shaded>
      <Shaded mode={mode} k="ast" tier={t.ast}>{stat(s.ast)}</Shaded>
      <Shaded mode={mode} k="stl" tier={t.stl}>{stat(s.stl)}</Shaded>
      <Shaded mode={mode} k="blk" tier={t.blk}>{stat(s.blk)}</Shaded>
      <Shaded mode={mode} k="tov" tier={t.tov}>{stat(s.tov)}</Shaded>
      <td className={`${styles.n} ${styles.value}`}>{p.value === null ? "—" : fmtValue(p.value)}</td>
      {onAdd && <td className={`${styles.n} ${styles.own}`}>
        {p.owner === null && p.waiver ? (
          <span className={styles.claimWrap}>
            <span className={styles.clears}>{fmtWaiverTime(p.waiver.clearsAt, timeZone, "day")}</span>
            <button
              type="button"
              className={`${styles.add} ${styles.claim}`}
              aria-label={`Claim ${fullName(p)} (${waiverTooltip(p.waiver, timeZone)})`}
              title={`Claim · ${waiverTooltip(p.waiver, timeZone)}`}
              onClick={() => onAdd(p.id)}
            >
              +
            </button>
          </span>
        ) : p.owner === null ? (
          <button type="button" className={styles.add} aria-label={`Add ${fullName(p)}`} title="Add" onClick={() => onAdd(p.id)}>
            +
          </button>
        ) : p.owner.teamId === myTeamId ? (
          <span className={styles.mine}><TeamLink team={{ id: p.owner.teamId, name: p.owner.abbreviation }} myTeamId={myTeamId} /></span>
        ) : (
          <TeamLink team={{ id: p.owner.teamId, name: p.owner.abbreviation }} myTeamId={myTeamId} />
        )}
      </td>}
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
  copy = false,
}: {
  label: string;
  title?: string;
  sortKey: SortKey;
  numeric?: boolean;
  sort: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  /** In StickyHeadTable's pinned copy: clickable, but out of the tab order. */
  copy?: boolean;
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
        tabIndex={copy ? -1 : undefined}
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

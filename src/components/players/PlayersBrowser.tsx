"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { PlayersResponse, PositionFilter, SortDir, SortKey, StatMode, StatRange } from "@/lib/types";
import { CURRENT_SEASON, SORT_KEYS, defaultSortDir, seasonLabel } from "@/lib/types";
import SegmentedToggle, { type SegmentedOption } from "@/components/SegmentedToggle";
import ThemeToggle from "@/components/ThemeToggle";
import PlayersTable from "./PlayersTable";
import { fetchJson, fmtGameDate } from "./format";
import PlayerModal from "./PlayerModal";
import styles from "./PlayersBrowser.module.css";

const PER_PAGE = 50;
const SEARCH_DEBOUNCE_MS = 250;

const POSITIONS: SegmentedOption<PositionFilter>[] = [
  { value: "all", label: "All positions" },
  { value: "G", label: "G" },
  { value: "F", label: "F" },
  { value: "C", label: "C" },
];

const RANGES: SegmentedOption<StatRange>[] = [
  { value: "season", label: "Season" },
  { value: "last14", label: "Last 14 days" },
];

const MODES: SegmentedOption<StatMode>[] = [
  { value: "avg", label: "Per game" },
  { value: "total", label: "Totals" },
];

interface UrlState {
  q: string;
  pos: PositionFilter;
  range: StatRange;
  mode: StatMode;
  sort: SortKey;
  dir: SortDir;
  page: number;
  player: number | null;
}

function readUrlState(params: URLSearchParams): UrlState {
  const pos = params.get("pos");
  const rawSort = params.get("sort") as SortKey | null;
  const sort: SortKey = rawSort && SORT_KEYS.includes(rawSort) ? rawSort : "value";
  const dir = params.get("dir");
  const page = Number(params.get("page"));
  const player = Number(params.get("player"));
  return {
    q: params.get("q") ?? "",
    pos: pos === "G" || pos === "F" || pos === "C" ? pos : "all",
    range: params.get("range") === "last14" ? "last14" : "season",
    mode: params.get("mode") === "total" ? "total" : "avg",
    sort,
    dir: dir === "asc" || dir === "desc" ? dir : defaultSortDir(sort),
    page: Number.isInteger(page) && page > 1 ? page : 1,
    player: Number.isInteger(player) && player > 0 ? player : null,
  };
}

/** Defaults are left out so the plain URL stays clean. */
function toQueryString(s: UrlState): string {
  const p = new URLSearchParams();
  if (s.q) p.set("q", s.q);
  if (s.pos !== "all") p.set("pos", s.pos);
  if (s.range !== "season") p.set("range", s.range);
  if (s.mode !== "avg") p.set("mode", s.mode);
  if (s.sort !== "value") p.set("sort", s.sort);
  if (s.dir !== defaultSortDir(s.sort)) p.set("dir", s.dir);
  if (s.page > 1) p.set("page", String(s.page));
  if (s.player !== null) p.set("player", String(s.player));
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

type Load =
  | { status: "loading"; data: PlayersResponse | null }
  | { status: "ready"; data: PlayersResponse }
  | { status: "error"; data: PlayersResponse | null; message: string };

export default function PlayersBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const state = readUrlState(new URLSearchParams(searchParams.toString()));
  const { q, pos, range, mode, sort, dir, page, player } = state;

  const navigate = useCallback(
    (patch: Partial<UrlState>, how: "push" | "replace" = "push") => {
      const next = { ...readUrlState(new URLSearchParams(window.location.search)), ...patch };
      const url = `${pathname}${toQueryString(next)}`;
      if (how === "push") router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [pathname, router],
  );

  // Search box: local state, written to the URL after a pause in typing.
  const [search, setSearch] = useState(q);
  const lastWrittenQ = useRef(q);
  useEffect(() => {
    // URL changed from outside (back/forward, reload): reflect it in the box.
    if (q !== lastWrittenQ.current) {
      lastWrittenQ.current = q;
      setSearch(q);
    }
  }, [q]);
  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === lastWrittenQ.current) return;
    const t = setTimeout(() => {
      lastWrittenQ.current = trimmed;
      navigate({ q: trimmed, page: 1 }, "replace");
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search, navigate]);

  // Table data.
  const [load, setLoad] = useState<Load>({ status: "loading", data: null });
  const [retryKey, setRetryKey] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    setLoad((prev) => ({ status: "loading", data: prev.data }));
    const params = new URLSearchParams({
      season: String(CURRENT_SEASON),
      range,
      mode,
      sort,
      dir,
      q,
      pos,
      page: String(page),
      perPage: String(PER_PAGE),
    });
    fetchJson<PlayersResponse>(`/api/players?${params}`, ctrl.signal)
      .then((data) => setLoad({ status: "ready", data }))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setLoad((prev) => ({
          status: "error",
          data: prev.data,
          message: err instanceof Error ? err.message : "Something went wrong",
        }));
      });
    return () => ctrl.abort();
  }, [q, pos, range, mode, sort, dir, page, retryKey]);

  // Modal: the open player lives in the URL. Remember whether we pushed the
  // entry ourselves, so closing can go back instead of stacking history.
  const openedHere = useRef(false);
  const openPlayer = useCallback(
    (id: number) => {
      openedHere.current = true;
      navigate({ player: id });
    },
    [navigate],
  );
  const closePlayer = useCallback(() => {
    if (openedHere.current) {
      openedHere.current = false;
      router.back();
    } else {
      navigate({ player: null }, "replace");
    }
  }, [navigate, router]);

  const data = load.data;
  const total = data?.total ?? 0;
  const shown = data?.players.length ?? 0;
  const first = data ? (data.page - 1) * data.perPage + 1 : 0;
  const last = first + shown - 1;
  const hasNext = page * PER_PAGE < total;
  let summary = " ";
  if (data) {
    if (total === 0) summary = "No players";
    else if (shown === 0) summary = `No players on this page · ${total.toLocaleString("en-US")} total`;
    else summary = `Showing ${first}–${last} of ${total.toLocaleString("en-US")} players`;
  }
  const season = data?.season ?? CURRENT_SEASON;

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <header className={styles.top}>
          <Link href="/" className={styles.logo}>
            Fantasy <b>Hoops</b>
          </Link>
          <ThemeToggle />
        </header>

        <h1 className={styles.title}>{range === "last14" ? "Last 14 days" : "Season averages"}</h1>
        <p className={styles.sub}>
          {seasonLabel(season)}
          {data?.range === "last14" && data.from && data.to && ` · ${fmtGameDate(data.from)} – ${fmtGameDate(data.to)}`}
          {" · "}
          {mode === "total" ? "totals" : "per game"} · 9-category
        </p>

        <div className={styles.bar}>
          <input
            type="search"
            className={styles.search}
            placeholder="Search players"
            aria-label="Search players"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <SegmentedToggle label="Position" options={POSITIONS} value={pos} onChange={(v) => navigate({ pos: v, page: 1 })} />
          <SegmentedToggle label="Games" options={RANGES} value={range} onChange={(v) => navigate({ range: v, page: 1 })} />
          <SegmentedToggle label="Stat mode" options={MODES} value={mode} onChange={(v) => navigate({ mode: v })} />
        </div>

        <PlayersTable
          data={data}
          mode={mode}
          sort={sort}
          dir={dir}
          onSort={(key) =>
            navigate({
              sort: key,
              dir: key === sort ? (dir === "asc" ? "desc" : "asc") : defaultSortDir(key),
              page: 1,
            })
          }
          status={load.status}
          errorMessage={load.status === "error" ? load.message : null}
          onRetry={() => setRetryKey((k) => k + 1)}
          onOpenPlayer={openPlayer}
        />

        <div className={styles.footer}>
          <span aria-live="polite">{summary}</span>
          <span className={styles.pager}>
            <button type="button" className={styles.pageBtn} disabled={page <= 1} onClick={() => navigate({ page: page - 1 })}>
              Previous
            </button>
            <button type="button" className={styles.pageBtn} disabled={!hasNext} onClick={() => navigate({ page: page + 1 })}>
              Next
            </button>
          </span>
        </div>
      </div>

      <PlayerModal playerId={player} onClose={closePlayer} />
    </div>
  );
}

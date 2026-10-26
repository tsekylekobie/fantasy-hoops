"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type {
  PlayDay, PlayerScope, PlayersResponse, PositionFilter, SortDir, SortKey, StatMode, StatRange, WaiverFilter,
} from "@/lib/types";
import { CURRENT_SEASON, PLAY_DAYS, SORT_KEYS, defaultSortDir } from "@/lib/types";
import MultiToggle from "@/components/MultiToggle";
import SegmentedToggle, { type SegmentedOption } from "@/components/SegmentedToggle";
import SiteHeader from "@/components/SiteHeader";
import PlayersTable from "./PlayersTable";
import { fetchJson, fmtGameDate } from "./format";
import PlayerModal from "./PlayerModal";
import AddDropSheet, { fetchMyTeamId } from "@/components/transactions/AddDropSheet";
import styles from "./PlayersBrowser.module.css";

const PER_PAGE = 50;
const SEARCH_DEBOUNCE_MS = 250;

const SCOPES: SegmentedOption<PlayerScope>[] = [
  { value: "fa", label: "Free agents" },
  { value: "all", label: "All players" },
];

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

const PLAYS: SegmentedOption<PlayDay>[] = [
  { value: "today", label: "Today" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "in2", label: "In 2 days" },
];

const WAIVERS: SegmentedOption<WaiverFilter>[] = [
  { value: "any", label: "Any" },
  { value: "on", label: "On waivers" },
  { value: "clears", label: "Clears by tomorrow" },
];

interface UrlState {
  q: string;
  scope: PlayerScope;
  pos: PositionFilter;
  range: StatRange;
  mode: StatMode;
  plays: PlayDay[];
  waivers: WaiverFilter;
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
  const plays = (params.get("plays") ?? "").split(",");
  const waivers = params.get("waivers");
  return {
    q: params.get("q") ?? "",
    scope: params.get("scope") === "all" ? "all" : "fa",
    pos: pos === "G" || pos === "F" || pos === "C" ? pos : "all",
    range: params.get("range") === "last14" ? "last14" : "season",
    mode: params.get("mode") === "total" ? "total" : "avg",
    plays: PLAY_DAYS.filter((d) => plays.includes(d)),
    waivers: waivers === "on" || waivers === "clears" ? waivers : "any",
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
  if (s.scope !== "fa") p.set("scope", s.scope);
  if (s.pos !== "all") p.set("pos", s.pos);
  if (s.range !== "season") p.set("range", s.range);
  if (s.mode !== "avg") p.set("mode", s.mode);
  if (s.plays.length > 0) p.set("plays", s.plays.join(","));
  if (s.waivers !== "any") p.set("waivers", s.waivers);
  if (s.sort !== "value") p.set("sort", s.sort);
  if (s.dir !== defaultSortDir(s.sort)) p.set("dir", s.dir);
  if (s.page > 1) p.set("page", String(s.page));
  if (s.player !== null) p.set("player", String(s.player));
  // Commas are legal in a query; keep "plays=tomorrow,in2" readable.
  const qs = p.toString().replace(/%2C/gi, ",");
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
  const { q, scope, pos, range, mode, plays, waivers, sort, dir, page, player } = state;
  const playsKey = plays.join(",");

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

  // Add sheet (over the table or the modal), and the manager's team for "mine" chips.
  const [adding, setAdding] = useState<number | null>(null);
  const [myTeamId, setMyTeamId] = useState<number | null>(null);
  const [movesKey, setMovesKey] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    fetchMyTeamId(ctrl.signal).then((id) => {
      if (!ctrl.signal.aborted) setMyTeamId(id);
    });
    return () => ctrl.abort();
  }, []);

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
      scope,
      q,
      pos,
      plays: playsKey,
      waivers,
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
  }, [q, scope, pos, range, mode, playsKey, waivers, sort, dir, page, retryKey, movesKey]);

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
    if (total === 0) summary = waivers !== "any" ? "No players on waivers" : scope === "fa" ? "No free agents" : "No players";
    else if (shown === 0) summary = `No players on this page · ${total.toLocaleString("en-US")} total`;
    else summary = `Showing ${first}–${last} of ${total.toLocaleString("en-US")} ${scope === "fa" ? "free agents" : "players"}`;
  }

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <SiteHeader />

        <h1 className={styles.title}>{range === "last14" ? "Last 14 days" : "Season averages"}</h1>
        {data?.range === "last14" && data.from && data.to && (
          <p className={styles.sub}>
            {fmtGameDate(data.from)} – {fmtGameDate(data.to)}
          </p>
        )}

        <div className={styles.bar}>
          <input
            type="search"
            className={styles.search}
            placeholder="Search players"
            aria-label="Search players"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <SegmentedToggle label="Players" options={SCOPES} value={scope} onChange={(v) => navigate({ scope: v, page: 1 })} />
          <SegmentedToggle label="Position" options={POSITIONS} value={pos} onChange={(v) => navigate({ pos: v, page: 1 })} />
          <SegmentedToggle label="Games" options={RANGES} value={range} onChange={(v) => navigate({ range: v, page: 1 })} />
          <SegmentedToggle label="Stat mode" options={MODES} value={mode} onChange={(v) => navigate({ mode: v })} />
        </div>

        {/* Streaming: who plays soon, and who comes off waivers soon. */}
        <div className={`${styles.bar} ${styles.stream}`}>
          <span className={styles.filter}>
            <span className={styles.filterLabel} aria-hidden="true">Plays</span>
            <MultiToggle label="Plays" anyLabel="Any day" options={PLAYS} value={plays} onChange={(v) => navigate({ plays: v, page: 1 })} />
          </span>
          <span className={styles.filter}>
            <span className={styles.filterLabel} aria-hidden="true">Waivers</span>
            <SegmentedToggle label="Waivers" options={WAIVERS} value={waivers} onChange={(v) => navigate({ waivers: v, page: 1 })} />
          </span>
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
          onAddPlayer={setAdding}
          myTeamId={myTeamId}
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

      <PlayerModal playerId={player} onClose={closePlayer} onAdd={setAdding} myTeamId={myTeamId} refreshKey={movesKey} />
      <AddDropSheet playerId={adding} onClose={() => setAdding(null)} onDone={() => setMovesKey((k) => k + 1)} />
    </div>
  );
}

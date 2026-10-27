"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type {
  CategoryWeights, PlayDay, PlayerScope, PlayersResponse, PositionFilter, SortDir, SortKey, StatMode, StatRange, WaiverFilter, WeightsResponse,
} from "@/lib/types";
import { CURRENT_SEASON, DEFAULT_WEIGHTS, PLAY_DAYS, SORT_KEYS, STAT_RANGES, defaultSortDir } from "@/lib/types";
import MultiToggle from "@/components/MultiToggle";
import SegmentedToggle, { type SegmentedOption } from "@/components/SegmentedToggle";
import SiteHeader from "@/components/SiteHeader";
import PlayersTable from "./PlayersTable";
import { fetchJson, fmtGameDate } from "./format";
import PlayerModal from "./PlayerModal";
import PuntWeights, { isDefaultWeights, readCachedWeights, weightsParam, writeCachedWeights } from "./PuntWeights";
import AddDropSheet, { fetchMyTeamId } from "@/components/transactions/AddDropSheet";
import styles from "./PlayersBrowser.module.css";

const PER_PAGE = 50;
const SEARCH_DEBOUNCE_MS = 250;
const WEIGHTS_DEBOUNCE_MS = 300;

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
  { value: "last30", label: "Last 30 days" },
  { value: "last14", label: "Last 14 days" },
];

const RANGE_TITLES: Record<StatRange, string> = { season: "Season averages", last30: "Last 30 days", last14: "Last 14 days" };

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
  /** Fantasy team id, or null for any. */
  team: number | null;
  /** NBA team abbreviation, or null for any. */
  nba: string | null;
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
  const team = Number(params.get("team"));
  const nba = params.get("nba")?.toUpperCase() ?? "";
  return {
    q: params.get("q") ?? "",
    scope: params.get("scope") === "all" ? "all" : "fa",
    pos: pos === "G" || pos === "F" || pos === "C" ? pos : "all",
    range: STAT_RANGES.find((r) => r === params.get("range")) ?? "season",
    mode: params.get("mode") === "total" ? "total" : "avg",
    plays: PLAY_DAYS.filter((d) => plays.includes(d)),
    waivers: waivers === "on" || waivers === "clears" ? waivers : "any",
    team: Number.isInteger(team) && team > 0 ? team : null,
    nba: /^[A-Z]{2,4}$/.test(nba) ? nba : null,
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
  if (s.team !== null) p.set("team", String(s.team));
  if (s.nba !== null) p.set("nba", s.nba);
  if (s.sort !== "value") p.set("sort", s.sort);
  if (s.dir !== defaultSortDir(s.sort)) p.set("dir", s.dir);
  if (s.page > 1) p.set("page", String(s.page));
  if (s.player !== null) p.set("player", String(s.player));
  // Commas are legal in a query; keep "plays=tomorrow,in2" readable.
  const qs = p.toString().replace(/%2C/gi, ",");
  return qs ? `?${qs}` : "";
}

const POSITION_NAMES: Record<Exclude<PositionFilter, "all">, string> = { G: "Guards", F: "Forwards", C: "Centers" };

/** One phrase per folded filter, for the closed Filters button. `changed` marks a non-default pick. */
function filterSummary(s: UrlState, teams: PlayersResponse["teamOptions"] | null): { text: string; changed: boolean }[] {
  const playLabels = PLAYS.filter((o) => s.plays.includes(o.value)).map((o) => o.label.toLowerCase());
  const teamLabels = [
    s.team !== null ? teams?.fantasy.find((t) => t.id === s.team)?.name ?? "One team" : null,
    s.nba,
  ].filter((x): x is string => x !== null);
  return [
    { text: s.scope === "all" ? "All players" : "Free agents", changed: s.scope !== "fa" },
    { text: teamLabels.length > 0 ? teamLabels.join(" · ") : "Any team", changed: teamLabels.length > 0 },
    { text: s.pos === "all" ? "All positions" : POSITION_NAMES[s.pos], changed: s.pos !== "all" },
    { text: `Plays ${playLabels.length > 0 ? playLabels.join(" or ") : "any day"}`, changed: playLabels.length > 0 },
    {
      text: s.waivers === "any" ? "Any waiver status" : WAIVERS.find((o) => o.value === s.waivers)!.label,
      changed: s.waivers !== "any",
    },
  ];
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
  const { q, scope, pos, range, mode, plays, waivers, team, nba, sort, dir, page, player } = state;
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

  const [filtersOpen, setFiltersOpen] = useState(false);

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

  // Punt weights: per user, not in the URL. `weights` follows the sliders;
  // `applied` (what the table is fetched with, cached and saved) trails it by
  // a pause. The browser cache lets the table load with them right away;
  // signed in, the account's saved weights then win (they follow the user
  // across devices) unless the sliders were already touched. Without a cache
  // the table waits for the account's weights before its first fetch.
  const [weights, setWeights] = useState<CategoryWeights>(DEFAULT_WEIGHTS);
  const [applied, setApplied] = useState<CategoryWeights | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [showWeights, setShowWeights] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const touchedWeights = useRef(false);
  useEffect(() => {
    const cached = readCachedWeights();
    if (cached) {
      setWeights(cached);
      setApplied(cached);
    }
    const ctrl = new AbortController();
    fetchJson<WeightsResponse>("/api/me/weights", ctrl.signal)
      .then((res) => {
        setSignedIn(res.signedIn);
        if (touchedWeights.current || (!res.signedIn && cached)) return;
        setWeights(res.weights);
        setApplied(res.weights);
        writeCachedWeights(res.weights);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setApplied((prev) => prev ?? DEFAULT_WEIGHTS);
      });
    return () => ctrl.abort();
  }, []);
  const changeWeights = (next: CategoryWeights) => {
    touchedWeights.current = true;
    setWeights(next);
    setSaveError(null);
  };
  useEffect(() => {
    if (!applied || weightsParam(weights) === weightsParam(applied)) return;
    const t = setTimeout(() => {
      setApplied(weights);
      writeCachedWeights(weights);
      if (!signedIn) return;
      fetch("/api/me/weights", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weights }),
      })
        .then(async (res) => {
          if (res.ok) return;
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setSaveError(body?.error ?? `Request failed (${res.status}).`);
        })
        .catch(() => setSaveError("Network error."));
    }, WEIGHTS_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [weights, applied, signedIn]);
  const appliedKey = applied ? weightsParam(applied) : null;

  // Table data.
  const [load, setLoad] = useState<Load>({ status: "loading", data: null });
  const [retryKey, setRetryKey] = useState(0);
  useEffect(() => {
    if (appliedKey === null) return;
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
      ...(team !== null && { team: String(team) }),
      ...(nba !== null && { nba }),
      weights: appliedKey,
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
  }, [q, scope, pos, range, mode, playsKey, waivers, team, nba, sort, dir, page, retryKey, movesKey, appliedKey]);

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
  const teamOptions = data?.teamOptions ?? null;
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

        <h1 className={styles.title}>{RANGE_TITLES[range]}</h1>
        {data?.range !== "season" && data?.from && data.to && (
          <p className={styles.sub}>
            {fmtGameDate(data.from)} – {fmtGameDate(data.to)}
          </p>
        )}

        <div className={styles.bar}>
          <SegmentedToggle label="Games" options={RANGES} value={range} onChange={(v) => navigate({ range: v, page: 1 })} />
          <SegmentedToggle label="Stat mode" options={MODES} value={mode} onChange={(v) => navigate({ mode: v })} />
          <input
            type="search"
            className={styles.search}
            placeholder="Search players"
            aria-label="Search players"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            type="button"
            className={styles.weightsBtn}
            aria-expanded={showWeights}
            onClick={() => setShowWeights((v) => !v)}
          >
            Punt weights{isDefaultWeights(weights) ? "" : " · custom"}
          </button>
        </div>

        {showWeights && (
          <PuntWeights weights={weights} onChange={changeWeights} signedIn={signedIn} saveError={saveError} />
        )}

        {/* The rest of the filters fold away; closed, the button sums up what's selected. */}
        <div className={styles.filters}>
          <button
            type="button"
            className={styles.filtersToggle}
            aria-expanded={filtersOpen}
            aria-controls="player-filters"
            onClick={() => setFiltersOpen((o) => !o)}
          >
            <span className={styles.chevron} aria-hidden="true" />
            <span className={styles.filtersTitle}>Filters</span>
            {!filtersOpen && (
              <span className={styles.filtersSummary}>
                <span className={styles.summaryParts}>
                  {filterSummary(state, teamOptions).map((part) => (
                    <span key={part.text} className={part.changed ? styles.changed : undefined}>
                      {part.text}
                    </span>
                  ))}
                </span>
              </span>
            )}
          </button>

          <div id="player-filters" className={styles.filtersPanel} hidden={!filtersOpen}>
            <span className={styles.filter}>
              <span className={styles.filterLabel} aria-hidden="true">Players</span>
              {/* Free agents have no fantasy team, so that pick clears the team filter. */}
              <SegmentedToggle
                label="Players"
                options={SCOPES}
                value={scope}
                onChange={(v) => navigate({ scope: v, ...(v === "fa" && { team: null }), page: 1 })}
              />
            </span>
            <span className={styles.filter}>
              <span className={styles.filterLabel} aria-hidden="true">Team</span>
              <span className={styles.selects}>
                {/* A fantasy team's players are rostered, so picking one shows all players. */}
                <select
                  className={styles.select}
                  aria-label="Fantasy team"
                  value={team ?? ""}
                  onChange={(e) => {
                    const id = e.target.value ? Number(e.target.value) : null;
                    navigate({ team: id, ...(id !== null && { scope: "all" }), page: 1 });
                  }}
                >
                  <option value="">All fantasy teams</option>
                  {teamOptions?.fantasy.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <select
                  className={styles.select}
                  aria-label="NBA team"
                  value={nba ?? ""}
                  onChange={(e) => navigate({ nba: e.target.value || null, page: 1 })}
                >
                  <option value="">All NBA teams</option>
                  {teamOptions?.nba.map((t) => <option key={t.abbreviation} value={t.abbreviation}>{t.name}</option>)}
                </select>
              </span>
            </span>
            <span className={styles.filter}>
              <span className={styles.filterLabel} aria-hidden="true">Position</span>
              <SegmentedToggle label="Position" options={POSITIONS} value={pos} onChange={(v) => navigate({ pos: v, page: 1 })} />
            </span>
            {/* Streaming: who plays soon, and who comes off waivers soon. */}
            <span className={styles.filter}>
              <span className={styles.filterLabel} aria-hidden="true">Plays</span>
              <MultiToggle label="Plays" anyLabel="Any day" options={PLAYS} value={plays} onChange={(v) => navigate({ plays: v, page: 1 })} />
            </span>
            <span className={styles.filter}>
              <span className={styles.filterLabel} aria-hidden="true">Waivers</span>
              <SegmentedToggle label="Waivers" options={WAIVERS} value={waivers} onChange={(v) => navigate({ waivers: v, page: 1 })} />
            </span>
          </div>
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

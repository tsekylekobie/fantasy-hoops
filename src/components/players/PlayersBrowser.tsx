"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { PlayersResponse, PositionFilter, StatMode } from "@/lib/types";
import { CURRENT_SEASON, seasonLabel } from "@/lib/types";
import PlayersTable from "./PlayersTable";
import { fetchJson } from "./format";
import PlayerModal from "./PlayerModal";
import styles from "./PlayersBrowser.module.css";

const PER_PAGE = 50;
const SEARCH_DEBOUNCE_MS = 250;

const POSITIONS: { value: PositionFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "G", label: "G" },
  { value: "F", label: "F" },
  { value: "C", label: "C" },
];

interface UrlState {
  q: string;
  pos: PositionFilter;
  mode: StatMode;
  page: number;
  player: number | null;
}

function readUrlState(params: URLSearchParams): UrlState {
  const pos = params.get("pos");
  const page = Number(params.get("page"));
  const player = Number(params.get("player"));
  return {
    q: params.get("q") ?? "",
    pos: pos === "G" || pos === "F" || pos === "C" ? pos : "all",
    mode: params.get("mode") === "total" ? "total" : "avg",
    page: Number.isInteger(page) && page > 1 ? page : 1,
    player: Number.isInteger(player) && player > 0 ? player : null,
  };
}

/** Defaults are left out so the plain URL stays clean. */
function toQueryString(s: UrlState): string {
  const p = new URLSearchParams();
  if (s.q) p.set("q", s.q);
  if (s.pos !== "all") p.set("pos", s.pos);
  if (s.mode !== "avg") p.set("mode", s.mode);
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
  const { q, pos, mode, page, player } = state;

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
      mode,
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
  }, [q, pos, mode, page, retryKey]);

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
        </header>

        <h1 className={styles.title}>Season averages</h1>
        <p className={styles.sub}>
          {seasonLabel(season)} · {mode === "total" ? "totals" : "per game"} · 9-category
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
          <div className={styles.group} role="group" aria-label="Position">
            {POSITIONS.map((p) => (
              <button
                key={p.value}
                type="button"
                className={styles.chip}
                aria-pressed={pos === p.value}
                onClick={() => pos !== p.value && navigate({ pos: p.value, page: 1 })}
              >
                {p.value === "all" ? "All positions" : p.label}
              </button>
            ))}
          </div>
          <div className={styles.group} role="group" aria-label="Stat mode">
            <button
              type="button"
              className={styles.chip}
              aria-pressed={mode === "avg"}
              onClick={() => mode !== "avg" && navigate({ mode: "avg" })}
            >
              Per game
            </button>
            <button
              type="button"
              className={styles.chip}
              aria-pressed={mode === "total"}
              onClick={() => mode !== "total" && navigate({ mode: "total" })}
            >
              Totals
            </button>
          </div>
          <span className={`${styles.chip} ${styles.static}`}>Sort: 9CAT value</span>
        </div>

        <PlayersTable
          data={data}
          mode={mode}
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

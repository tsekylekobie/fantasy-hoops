"use client";

// "Updated 4 min ago · Refresh": how fresh the Yahoo mirror is, and a button
// that syncs now (POST /api/yahoo/refresh: today's rosters, the latest
// transactions and this week's scoreboard; once a minute for the whole league),
// then re-renders the page with router.refresh(). No props: it fetches
// /api/yahoo/status itself, and renders nothing when signed out, outside the
// league, or with no Yahoo connection.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { YahooRefreshResponse, YahooStatusResponse } from "@/lib/types";
import styles from "./YahooRefresh.module.css";

/** "just now", "4 min ago", "2 h ago", "3 days ago". */
export function ago(iso: string, nowMs: number): string {
  const min = Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export default function YahooRefresh() {
  const router = useRouter();
  const [status, setStatus] = useState<YahooStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const res = await fetch("/api/yahoo/status", { cache: "no-store" }).catch(() => null);
    setStatus(res?.ok ? ((await res.json()) as YahooStatusResponse) : null);
  }, []);

  useEffect(() => {
    void load();
    // Keep "x min ago" current, and pick up the worker's passes.
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const poll = setInterval(() => void load(), 5 * 60_000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [load]);

  if (!status?.connected) return null;

  async function refresh() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/yahoo/refresh", { method: "POST" });
      const body = (await res.json().catch(() => null)) as (YahooRefreshResponse & { error?: string }) | null;
      if (body?.status) setStatus(body.status);
      if (!res.ok) setMessage(body?.error ?? `Refresh failed (${res.status}).`);
      else if (!body?.ok) setMessage(body?.message ?? "Refresh failed.");
      else router.refresh();
    } catch {
      setMessage("Couldn't reach the server.");
    } finally {
      setNow(Date.now());
      setBusy(false);
    }
  }

  const stale = status.lastError && (!status.lastRefreshAt || (status.lastErrorAt ?? "") > status.lastRefreshAt);
  return (
    <span className={styles.bar} aria-live="polite">
      <span title={status.lastRefreshAt ? new Date(status.lastRefreshAt).toLocaleString() : undefined}>
        {status.lastRefreshAt ? `Updated ${ago(status.lastRefreshAt, now)}` : "Not synced from Yahoo yet"}
      </span>
      <span aria-hidden="true">·</span>
      <button type="button" className={styles.refresh} onClick={refresh} disabled={busy}>
        {busy ? "Refreshing…" : "Refresh"}
      </button>
      {(message || stale) && (
        <span className={styles.problem} title={status.lastError ?? undefined}>
          {message ?? (status.throttledUntil ? "Yahoo is busy; trying again soon." : "Last sync failed.")}
        </span>
      )}
    </span>
  );
}

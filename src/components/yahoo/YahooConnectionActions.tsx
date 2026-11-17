"use client";

// The commissioner's buttons on /league/yahoo: pick the league to mirror
// (POST /api/yahoo/league) and disconnect (DELETE /api/yahoo/league).
// Connecting is a plain link to /api/yahoo/connect, in the page.
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "./YahooConnection.module.css";

async function send(method: "POST" | "DELETE", body?: unknown): Promise<string | null> {
  const res = await fetch("/api/yahoo/league", {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => null);
  if (!res) return "Couldn't reach the server.";
  if (res.ok) return null;
  return ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Request failed (${res.status}).`;
}

export function PickLeague({ leagues }: { leagues: { key: string; name: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <ul className={styles.leagues}>
        {leagues.map((l) => (
          <li key={l.key}>
            <span>
              {l.name} <small>({l.key})</small>
            </span>
            <button
              type="button"
              className={styles.button}
              disabled={busy !== null}
              onClick={async () => {
                setBusy(l.key);
                setError(await send("POST", { leagueKey: l.key }));
                setBusy(null);
                router.refresh();
              }}
            >
              {busy === l.key ? "Choosing…" : "Mirror this league"}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className={styles.error}>{error}</p>}
    </>
  );
}

export function Disconnect() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className={styles.quiet}
        disabled={busy}
        onClick={async () => {
          if (!confirm("Disconnect Yahoo? The league stays as it is now, but nothing updates until someone connects again.")) return;
          setBusy(true);
          setError(await send("DELETE"));
          setBusy(false);
          router.refresh();
        }}
      >
        {busy ? "Disconnecting…" : "Disconnect"}
      </button>
      {error && <span className={styles.error}>{error}</span>}
    </>
  );
}

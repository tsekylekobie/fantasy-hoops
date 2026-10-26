"use client";

// My team's "My claims": the manager's pending waiver claims in the order the
// waiver run tries them (reorder with the arrows, or cancel), and the claims
// decided in the last week with why any failed. API: /api/team/claims.
import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchJson, fmtWaiverDays, fmtWaiverTime, fullName, teamPos } from "@/components/players/format";
import type { ClaimOrderRequest, MyClaimsResponse, WaiverClaim } from "@/lib/types";
import styles from "./MyClaims.module.css";

const STATUS: Record<Exclude<WaiverClaim["status"], "pending">, { label: string; className: string }> = {
  completed: { label: "Won", className: styles.won },
  failed: { label: "Failed", className: styles.failed },
  cancelled: { label: "Cancelled", className: styles.cancelled },
};

export default function MyClaims() {
  const [data, setData] = useState<MyClaimsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchJson<MyClaimsResponse>("/api/team/claims", ctrl.signal)
      .then(setData)
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : "Couldn’t load claims.");
      });
    return () => ctrl.abort();
  }, []);

  async function send(url: string, init: RequestInit) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(url, init);
      const body = (await res.json().catch(() => null)) as (MyClaimsResponse & { error?: string }) | null;
      if (!res.ok || !body) throw new Error(body?.error ?? `Request failed (${res.status}).`);
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  function move(index: number, by: -1 | 1) {
    if (!data) return;
    const ids = data.pending.map((c) => c.id);
    [ids[index], ids[index + by]] = [ids[index + by], ids[index]];
    // Show the new order right away; the response replaces it.
    setData({ ...data, pending: ids.map((id) => data.pending.find((c) => c.id === id)!) });
    const body: ClaimOrderRequest = { order: ids };
    void send("/api/team/claims", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  const cancel = (id: number) => void send(`/api/team/claims/${id}`, { method: "DELETE" });

  if (!data) {
    return (
      <section className={styles.card} aria-labelledby="my-claims-heading">
        <h3 id="my-claims-heading">My claims</h3>
        <p className={styles.empty} role={error ? "alert" : "status"}>{error ?? "Loading claims…"}</p>
      </section>
    );
  }

  const tz = data.timeZone;
  return (
    <section className={styles.card} aria-labelledby="my-claims-heading" id="claims">
      <div className={styles.hd}>
        <h3 id="my-claims-heading">My claims</h3>
        <p className={styles.sub}>
          Waivers run {fmtWaiverDays(data.waiverDaysOfWeek)} at {fmtWaiverTime(data.nextRunAt, tz, "long").split(" · ")[1]}
          {data.waiverPriority !== null && ` · Your waiver priority ${data.waiverPriority} of ${data.teamCount}`}
        </p>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {data.pending.length === 0 ? (
        <p className={styles.empty}>
          No pending claims. Players on waivers have a Claim button on <Link href="/players">Players</Link>.
        </p>
      ) : (
        <>
          <p className={styles.lede}>
            When more than one of your claims processes in the same run, they&apos;re tried top to bottom.
          </p>
          <ol className={styles.list}>
            {data.pending.map((c, i) => (
              <li key={c.id} className={styles.claim}>
                <span className={styles.rank}>{i + 1}</span>
                <Players c={c} />
                <span className={styles.when}>Processes {fmtWaiverTime(c.processAt, tz, "long")}</span>
                <span className={styles.actions}>
                  <button type="button" className={styles.icon} aria-label={`Move ${fullName(c.add)} claim up`} disabled={saving || i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button
                    type="button"
                    className={styles.icon}
                    aria-label={`Move ${fullName(c.add)} claim down`}
                    disabled={saving || i === data.pending.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </button>
                  <button type="button" className={styles.btn} disabled={saving} onClick={() => cancel(c.id)}>
                    Cancel
                  </button>
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
      {data.recent.length > 0 && (
        <>
          <h4 className={styles.h4}>Last 7 days</h4>
          <ul className={styles.list}>
            {data.recent.map((c) => {
              const s = STATUS[c.status as keyof typeof STATUS];
              return (
                <li key={c.id} className={styles.claim}>
                  <span className={`${styles.status} ${s.className}`}>{s.label}</span>
                  <Players c={c} reason={c.status === "failed" ? c.failureReason : null} />
                  <span className={styles.when}>{c.processedAt ? fmtWaiverTime(c.processedAt, tz, "long") : ""}</span>
                  <span />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function Players({ c, reason = null }: { c: WaiverClaim; reason?: string | null }) {
  return (
    <span className={styles.players}>
      <span>
        <b className={styles.plus} aria-label="Add">+</b> {fullName(c.add)} <small>{teamPos(c.add.teamAbbr, c.add.position)}</small>
      </span>
      {c.drop && (
        <span>
          <b className={styles.minus} aria-label="Drop">−</b> {fullName(c.drop)} <small>{teamPos(c.drop.teamAbbr, c.drop.position)}</small>
        </span>
      )}
      {reason && <span className={styles.reason}>{reason}</span>}
    </span>
  );
}

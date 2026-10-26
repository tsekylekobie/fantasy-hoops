"use client";

// My team's "My claims": the manager's pending waiver claims in the order the
// waiver run tries them (reorder with the arrows, or cancel), and the claims
// decided in the last week with why any failed. In FAAB leagues each pending
// claim shows its bid, editable in place, and the list is in bid order: the
// arrows only reorder claims with the same bid, the one thing the manager's
// own order decides. API: /api/team/claims.
import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchJson, fmtWaiverDays, fmtWaiverTime, fullName, teamPos } from "@/components/players/format";
import { faabBidProblem } from "@/lib/transactions/policy";
import type { ClaimOrderRequest, FaabBudget, MyClaimsResponse, WaiverClaim } from "@/lib/types";
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

  async function send(url: string, init: RequestInit): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(url, init);
      const body = (await res.json().catch(() => null)) as (MyClaimsResponse & { error?: string }) | null;
      if (!res.ok || !body) throw new Error(body?.error ?? `Request failed (${res.status}).`);
      setData(body);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  // FAAB: only claims with the same bid can swap (bids decide the rest).
  const canSwap = (i: number, j: number) =>
    !!data && j >= 0 && j < data.pending.length && (!data.faab || data.pending[i].bid === data.pending[j].bid);

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
  const setBid = (id: number, bid: number) =>
    send(`/api/team/claims/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bid }) });

  if (!data) {
    return (
      <section className={styles.card} aria-labelledby="my-claims-heading">
        <h3 id="my-claims-heading">My claims</h3>
        <p className={styles.empty} role={error ? "alert" : "status"}>{error ?? "Loading claims…"}</p>
      </section>
    );
  }

  const tz = data.timeZone;
  const faab = data.faab;
  return (
    <section className={styles.card} aria-labelledby="my-claims-heading" id="claims">
      <div className={styles.hd}>
        <h3 id="my-claims-heading">My claims</h3>
        <p className={styles.sub}>
          Waivers run {fmtWaiverDays(data.waiverDaysOfWeek)} at {fmtWaiverTime(data.nextRunAt, tz, "long").split(" · ")[1]}
          {faab && ` · FAAB $${faab.balance} of $${faab.budget} left`}
          {data.waiverPriority !== null && ` · ${faab ? "Priority on tied bids" : "Your waiver priority"} ${data.waiverPriority} of ${data.teamCount}`}
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
            {faab
              ? "Highest bids are tried first. Bids are blind, you pay only for claims you win, and each is checked against what you have left when the run gets to it. Use the arrows to choose which of your claims with the same bid goes first."
              : "When more than one of your claims processes in the same run, they’re tried top to bottom."}
          </p>
          <ol className={styles.list}>
            {data.pending.map((c, i) => (
              <li
                key={c.id}
                className={`${styles.claim} ${faab && i > 0 && data.pending[i - 1].bid !== c.bid ? styles.newBid : ""}`}
              >
                <span className={styles.rank}>{i + 1}</span>
                <Players c={c} />
                <span className={styles.when}>Processes {fmtWaiverTime(c.processAt, tz, "long")}</span>
                <span className={styles.actions}>
                  {faab && <BidInput claim={c} faab={faab} disabled={saving} onSave={(bid) => setBid(c.id, bid)} />}
                  <button type="button" className={styles.icon} aria-label={`Move ${fullName(c.add)} claim up`} disabled={saving || !canSwap(i, i - 1)} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button
                    type="button"
                    className={styles.icon}
                    aria-label={`Move ${fullName(c.add)} claim down`}
                    disabled={saving || !canSwap(i, i + 1)}
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
                  <span className={`${styles.status} ${s.className}`}>
                    {s.label}
                    {c.status === "completed" && c.bid !== null && ` $${c.bid}`}
                  </span>
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

/** A pending claim's FAAB bid: saves on Enter or when focus leaves, if it changed and is allowed. */
function BidInput({
  claim, faab, disabled, onSave,
}: { claim: WaiverClaim; faab: FaabBudget; disabled: boolean; onSave: (bid: number) => Promise<boolean> }) {
  const saved = claim.bid ?? faab.minBid;
  const [value, setValue] = useState(String(saved));
  useEffect(() => setValue(String(saved)), [saved]);
  const n = value.trim() === "" ? NaN : Number(value);
  const problem = value.trim() === "" ? "Enter a bid." : faabBidProblem(faab, n);

  async function commit() {
    if (problem || n === saved) {
      if (problem) setValue(String(saved));
      return;
    }
    if (!(await onSave(n))) setValue(String(saved));
  }

  return (
    <label className={styles.bid} title={problem ?? `Your bid for ${fullName(claim.add)}`}>
      <span aria-hidden="true">$</span>
      <input
        type="number"
        inputMode="numeric"
        min={faab.minBid}
        max={faab.balance}
        step={1}
        value={value}
        disabled={disabled}
        aria-label={`Bid for ${fullName(claim.add)}`}
        aria-invalid={problem !== null}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setValue(String(saved));
        }}
      />
    </label>
  );
}

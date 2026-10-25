"use client";

// The add / claim sheet: docs/design/claim-player.mockup.html. Asks who to
// drop when the roster is full, confirms, then shows the result. Free agents
// join right away; waiver players (mode "waiver") will become a claim.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import Avatar from "@/components/Avatar";
import { fetchJson, fmtAvg, fmtPct, fullName, teamPos } from "@/components/players/format";
import type { CategoryLine, RosterMoveOption, RosterMoveRequest, RosterMoveResult, RosterMovesContext } from "@/lib/types";
import styles from "./AddDropSheet.module.css";

interface Props {
  /** The player to add; null keeps the sheet closed. */
  playerId: number | null;
  onClose: () => void;
  /** After a move goes through (rosters changed or claim placed). */
  onDone: (result: RosterMoveResult) => void;
}

type Load =
  | { status: "loading"; id: number }
  | { status: "ready"; id: number; data: RosterMovesContext }
  | { status: "error"; id: number; message: string; signIn: boolean };

export default function AddDropSheet({ playerId, onClose, onDone }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [load, setLoad] = useState<Load | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RosterMoveResult | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (playerId !== null && !dialog.open) dialog.showModal();
    else if (playerId === null && dialog.open) dialog.close();
  }, [playerId]);

  useEffect(() => {
    if (playerId === null) return;
    const ctrl = new AbortController();
    setLoad({ status: "loading", id: playerId });
    setPick(null);
    setError(null);
    setResult(null);
    fetch(`/api/team/transactions?add=${playerId}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (res.status === 401) {
          setLoad({ status: "error", id: playerId, message: "Sign in to add players.", signIn: true });
          return;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed (${res.status}).`);
        }
        setLoad({ status: "ready", id: playerId, data: (await res.json()) as RosterMovesContext });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setLoad({ status: "error", id: playerId, message: err instanceof Error ? err.message : "Something went wrong.", signIn: false });
      });
    return () => ctrl.abort();
  }, [playerId]);

  const data = load?.status === "ready" && load.id === playerId ? load.data : null;
  const add = data?.add ?? null;
  const full = data !== null && data.rosterCount >= data.rosterLimit;
  // An illegal roster (a healthy player on IL, or too many active) can only
  // add with a drop that fixes it.
  const illegal = data !== null && data.rosterProblems.length > 0;
  const fixes = data?.roster.filter((p) => p.fixesIllegalRoster) ?? [];
  const dropping = data?.roster.find((p) => p.id === pick) ?? null;
  // Dropping an IL player doesn't open a spot.
  const needsPick = illegal
    ? !dropping?.fixesIllegalRoster
    : full && (dropping === null || dropping.slot === "IL" || dropping.slot === "IL+");
  const blocked = add?.addBlocked ?? (illegal && fixes.length === 0 ? "illegal" : null);
  const claim = add?.mode === "waiver";

  async function submit() {
    if (!add || saving) return;
    setSaving(true);
    setError(null);
    try {
      const body: RosterMoveRequest = { addPlayerId: add.id, ...(dropping ? { dropPlayerId: dropping.id } : {}) };
      const res = await fetch("/api/team/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as (RosterMoveResult & { error?: string }) | null;
      if (!res.ok || !json) throw new Error(json?.error ?? `Request failed (${res.status}).`);
      setResult(json);
      onDone(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="add-sheet-title"
      onCancel={(e) => {
        e.preventDefault();
        onCloseRef.current();
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onCloseRef.current();
      }}
    >
      <div className={styles.hd}>
        {add ? (
          <>
            <Avatar player={add} size={56} />
            <div className={styles.headText}>
              <h2 id="add-sheet-title" className={styles.title}>
                {claim ? "Claim" : "Add"} {fullName(add)}
                {claim && <span className={styles.chip}>On waivers</span>}
              </h2>
              <p className={styles.sub}>
                {teamPos(add.teamAbbr, add.position)} · {add.owner ? `On ${add.owner.abbreviation}` : claim ? "Waivers" : "Free agent"}
              </p>
            </div>
          </>
        ) : (
          <div className={styles.headText}>
            <h2 id="add-sheet-title" className={styles.title}>
              {load?.status === "error" ? "Can’t add player" : "Loading…"}
            </h2>
          </div>
        )}
        <button type="button" className={styles.x} aria-label="Close" onClick={() => onCloseRef.current()}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M3 3l12 12M15 3L3 15" />
          </svg>
        </button>
      </div>

      {add && <Line data={add.seasonAverages} />}

      {load?.status === "error" && load.id === playerId && (
        <div className={styles.state} role="alert">
          <span>{load.message}</span>
          {load.signIn && (
            <Link className={`${styles.btn} ${styles.pri}`} href="/dev/sign-in">
              Sign in
            </Link>
          )}
        </div>
      )}
      {!data && load?.status === "loading" && (
        <div className={styles.state} role="status">
          Loading your roster…
        </div>
      )}

      {data && add && result && <Done data={data} result={result} onClose={() => onCloseRef.current()} />}

      {data && add && !result && (
        <>
          {add.addBlocked ? (
            <div className={styles.body}>
              <p className={styles.blocked} role="alert">{add.addBlocked}</p>
            </div>
          ) : illegal ? (
            <div className={styles.body}>
              <h3 className={styles.h3}>Your roster is illegal</h3>
              <div className={styles.blocked} role="alert">
                {data.rosterProblems.map((m) => <p key={m}>{m}</p>)}
              </div>
              {fixes.length > 0 ? (
                <>
                  <p className={styles.lede}>
                    You can&apos;t add players until it&apos;s fixed. Dropping one of these fixes it and makes room for {fullName(add)}:
                  </p>
                  <div className={styles.list} role="radiogroup" aria-label="Player to drop">
                    {fixes.map((p) => (
                      <DropOption key={p.id} p={p} checked={pick === p.id} onPick={() => setPick(p.id)} />
                    ))}
                  </div>
                </>
              ) : (
                <p className={styles.lede}>
                  You can&apos;t add players or place claims until it&apos;s fixed. <Link href="/my-team">Fix it on My team</Link>.
                </p>
              )}
            </div>
          ) : full ? (
            <div className={styles.body}>
              <h3 className={styles.h3}>Choose who to drop</h3>
              <p className={styles.lede}>
                Your roster is full ({data.rosterCount} of {data.rosterLimit}, IL not counted). The dropped player goes back
                to free agents.
              </p>
              <div className={styles.list} role="radiogroup" aria-label="Player to drop">
                {/* Dropping an IL player wouldn't open a spot. */}
                {data.roster.filter((p) => p.slot !== "IL" && p.slot !== "IL+").map((p) => (
                  <DropOption key={p.id} p={p} checked={pick === p.id} onPick={() => setPick(p.id)} />
                ))}
              </div>
            </div>
          ) : (
            <div className={styles.body}>
              <h3 className={styles.h3}>Open roster spot</h3>
              <p className={styles.lede}>
                You have {data.rosterLimit - data.rosterCount} open spot{data.rosterLimit - data.rosterCount > 1 ? "s" : ""} (
                {data.rosterCount} of {data.rosterLimit}, IL not counted). {fullName(add)} joins your bench.
              </p>
            </div>
          )}

          {!blocked && (
            <div className={styles.sum}>
              <div className={styles.row}>
                <span>Add</span>
                <b className={styles.plus}>{fullName(add)}</b>
              </div>
              {(full || illegal) && (
                <div className={styles.row}>
                  <span>Drop</span>
                  <b className={styles.minus}>{dropping ? fullName(dropping) : "Pick a player"}</b>
                </div>
              )}
              <div className={styles.row}>
                <span>Processes</span>
                <b>{claim ? "At the next waiver run" : "Right away"}</b>
              </div>
              {claim && data.team.waiverPriority !== null && (
                <div className={styles.row}>
                  <span>Your waiver priority</span>
                  <b>
                    {data.team.waiverPriority} of {data.teamCount}
                  </b>
                </div>
              )}
              <div className={styles.row}>
                <span>Moves this week</span>
                <b>
                  {data.addsThisWeek}
                  {data.maxAddsPerWeek !== null && ` of ${data.maxAddsPerWeek}`} used
                </b>
              </div>
            </div>
          )}

          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}

          <div className={styles.ft}>
            <button type="button" className={styles.btn} onClick={() => onCloseRef.current()}>
              Cancel
            </button>
            {!blocked && (
              <button
                type="button"
                className={`${styles.btn} ${styles.pri}`}
                disabled={needsPick || saving || (dropping?.dropBlocked ?? null) !== null}
                onClick={submit}
              >
                {saving ? "Saving…" : claim ? "Place claim" : dropping ? "Add and drop" : "Add player"}
              </button>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}

function Line({ data }: { data: CategoryLine | null }) {
  const tiles: [string, string][] = [
    ["FG%", data ? fmtPct(data.fgPct) : "—"],
    ["FT%", data ? fmtPct(data.ftPct) : "—"],
    ["3PM", data ? fmtAvg(data.fg3m) : "—"],
    ["PTS", data ? fmtAvg(data.pts) : "—"],
    ["REB", data ? fmtAvg(data.reb) : "—"],
    ["AST", data ? fmtAvg(data.ast) : "—"],
    ["STL", data ? fmtAvg(data.stl) : "—"],
    ["BLK", data ? fmtAvg(data.blk) : "—"],
    ["TO", data ? fmtAvg(data.tov) : "—"],
  ];
  return (
    <dl className={styles.line} aria-label="Season per-game averages">
      {tiles.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function DropOption({ p, checked, onPick }: { p: RosterMoveOption; checked: boolean; onPick: () => void }) {
  const pos = (p.position ?? "").replace("-", "/");
  const status = p.slot === "IL" || p.slot === "IL+" ? p.slot : p.injuryStatus === "Day-To-Day" ? "DTD" : p.injuryStatus;
  const stats = p.pts === null ? "No games yet" : `${fmtAvg(p.pts)} pts, ${fmtAvg(p.reb ?? 0)} reb`;
  const meta = [pos, status, p.dropBlocked ? "Locked" : stats].filter(Boolean).join(" · ");
  const disabled = p.dropBlocked !== null;
  return (
    <label
      className={`${styles.opt} ${checked ? styles.on : ""} ${disabled ? styles.off : ""}`}
      title={p.dropBlocked ?? undefined}
    >
      <input type="radio" name="drop" checked={checked} disabled={disabled} onChange={onPick} />
      <b>{fullName(p)}</b>
      <small>{meta}</small>
    </label>
  );
}

function Done({ data, result, onClose }: { data: RosterMovesContext; result: RosterMoveResult; onClose: () => void }) {
  const added = result.added ? fullName(result.added) : "";
  const pending = result.status === "pending";
  return (
    <div className={styles.done} role="status">
      <div className={styles.ck} aria-hidden="true">
        <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 13.5l4.5 4.5L20 8" />
        </svg>
      </div>
      <h3 className={styles.doneTitle}>{pending ? "Claim placed" : "Player added"}</h3>
      <p>
        {pending
          ? `If it goes through, ${added} joins your bench${result.dropped ? ` and ${fullName(result.dropped)} is dropped` : ""}.`
          : `${added} is on ${data.team.name}'s bench${result.dropped ? ` and ${fullName(result.dropped)} is back in free agents` : ""}. Set your lineup on My team.`}
      </p>
      <div className={styles.doneFt}>
        <Link className={`${styles.btn} ${styles.pri}`} href="/my-team">
          Go to my team
        </Link>
        <button type="button" className={styles.btn} onClick={onClose}>
          Back to players
        </button>
      </div>
    </div>
  );
}

/** Just the manager's team id, for "mine" chips; null when signed out or teamless. */
export async function fetchMyTeamId(signal: AbortSignal): Promise<number | null> {
  try {
    return (await fetchJson<RosterMovesContext>("/api/team/transactions", signal)).team.id;
  } catch {
    return null;
  }
}

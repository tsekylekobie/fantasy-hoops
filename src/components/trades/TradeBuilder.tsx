"use client";

// Trade builder (/team/[id]/trade): your roster and theirs side by side. Tick
// the players you'd send and the ones you want, add a note, and propose. The
// other manager accepts or rejects it from their My team page; then the league
// reviews it (see TradesPanel). Rosters come from GET /api/trades/builder.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Avatar from "@/components/Avatar";
import SiteHeader from "@/components/SiteHeader";
import { fetchJson, fmtAvg, fmtValue, fullName } from "@/components/players/format";
import type { Trade, TradeBuilderResponse, TradeProposal, TradeRosterPlayer } from "@/lib/types";
import styles from "./Trades.module.css";

const MAX_SIDE = 6;
const isActive = (p: TradeRosterPlayer) => p.slot !== "IL" && p.slot !== "IL+";

/** Active (non-IL) players after the trade; arrivals go to the bench. */
function activeAfter(roster: TradeRosterPlayer[], out: Set<number>, incoming: number): number {
  return roster.filter((p) => isActive(p) && !out.has(p.id)).length + incoming;
}

export default function TradeBuilder({ partnerId }: { partnerId: number }) {
  const router = useRouter();
  const [data, setData] = useState<TradeBuilderResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [send, setSend] = useState<Set<number>>(new Set());
  const [receive, setReceive] = useState<Set<number>>(new Set());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchJson<TradeBuilderResponse>(`/api/trades/builder?team=${partnerId}`, ctrl.signal)
      .then(setData)
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) setLoadError(err instanceof Error ? err.message : "Something went wrong");
      });
    return () => ctrl.abort();
  }, [partnerId]);

  if (!data) {
    return (
      <Shell>
        {loadError ? (
          <div className={`${styles.note} ${styles.error}`} role="alert"><p>{loadError}</p></div>
        ) : (
          <p className={styles.loading}>Loading rosters…</p>
        )}
      </Shell>
    );
  }

  const { settings, myTeam, partner } = data;
  const toggle = (set: Set<number>, update: (s: Set<number>) => void, id: number) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else if (next.size < MAX_SIDE) next.add(id);
    update(next);
    setError(null);
  };
  const sending = myTeam.players.filter((p) => send.has(p.id));
  const receiving = partner.players.filter((p) => receive.has(p.id));
  const myAfter = activeAfter(myTeam.players, send, receive.size);
  const theirAfter = activeAfter(partner.players, receive, send.size);
  const myNow = myTeam.players.filter(isActive).length;
  const theirNow = partner.players.filter(isActive).length;
  const tooBig = [
    myAfter > settings.activeLimit && myAfter > myNow ? `You'd have ${myAfter} active players (limit ${settings.activeLimit}); drop ${myAfter - settings.activeLimit} first or send more.` : null,
    theirAfter > settings.activeLimit && theirAfter > theirNow ? `${partner.name} would have ${theirAfter} active players (limit ${settings.activeLimit}); ask for fewer.` : null,
  ].filter(Boolean) as string[];
  const pastDeadline = settings.deadline !== null && data.today > settings.deadline;
  const ready = sending.length > 0 && receiving.length > 0 && tooBig.length === 0 && !pastDeadline;

  async function propose() {
    setSaving(true);
    setError(null);
    try {
      const body: TradeProposal = {
        partnerTeamId: partner.id,
        sendPlayerIds: [...send],
        receivePlayerIds: [...receive],
        note: note.trim() || undefined,
      };
      const res = await fetch("/api/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as (Trade & { error?: string }) | null;
      if (!res.ok || !json) throw new Error(json?.error || `Request failed (${res.status}).`);
      router.push("/my-team#trades");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't propose the trade.");
      setSaving(false);
    }
  }

  const review =
    settings.review === "none"
      ? "It processes as soon as they accept."
      : settings.review === "league_vote"
        ? `Once they accept, the league has ${settings.reviewDays} days to review it; ${settings.vetoVotes} veto votes kill it.`
        : `Once they accept, the commissioner has ${settings.reviewDays} days to review it.`;

  return (
    <Shell>
      <div className={styles.head}>
        <h1 className={styles.title}>Trade with {partner.name}</h1>
        <Link className={styles.btn} href={`/team/${partner.id}`}>Back to their team</Link>
      </div>
      <p className={styles.sub}>
        Pick players from each roster. {partner.name} can accept or reject your offer. {review}
      </p>
      {pastDeadline && (
        <div className={`${styles.note} ${styles.error}`} role="alert"><p>The trade deadline ({settings.deadline}) has passed.</p></div>
      )}

      <div className={styles.cols}>
        <Roster
          title="You send"
          team={myTeam.name}
          players={myTeam.players}
          picked={send}
          onPick={(id) => toggle(send, setSend, id)}
        />
        <Roster
          title="You receive"
          team={partner.name}
          players={partner.players}
          picked={receive}
          onPick={(id) => toggle(receive, setReceive, id)}
        />
      </div>

      <section className={styles.summary} aria-label="Trade summary">
        <div className={styles.gets}>
          <p className={styles.label}>{partner.name} gets</p>
          <Chips players={sending} empty="Pick players from your roster" />
        </div>
        <div className={styles.gets}>
          <p className={styles.label}>You get</p>
          <Chips players={receiving} empty={`Pick players from ${partner.name}`} />
        </div>
        <label className={styles.noteField}>
          Note to {partner.name} (optional)
          <textarea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Pitch your offer…" />
        </label>
        {tooBig.map((t) => (
          <div key={t} className={`${styles.note} ${styles.warn} ${styles.wide}`}><p>{t}</p></div>
        ))}
        {error && (
          <div className={`${styles.note} ${styles.error} ${styles.wide}`} role="alert"><p>{error}</p></div>
        )}
        <div className={styles.submit}>
          <p>
            {sending.length}-for-{receiving.length} · up to {MAX_SIDE} players a side. Players arrive on the bench.
          </p>
          <button type="button" className={`${styles.btn} ${styles.primary}`} disabled={!ready || saving} onClick={() => void propose()}>
            {saving ? "Proposing…" : "Propose trade"}
          </button>
        </div>
      </section>
    </Shell>
  );
}

function Roster({ title, team, players, picked, onPick }: {
  title: string;
  team: string;
  players: TradeRosterPlayer[];
  picked: Set<number>;
  onPick: (id: number) => void;
}) {
  return (
    <section className={styles.card} aria-label={`${title}: ${team}`}>
      <h3>
        {title}
        <span className={styles.when}>{team}</span>
      </h3>
      <div className={`${styles.r} ${styles.h}`}>
        <span />
        <span>Player</span>
        <span className={`${styles.n} ${styles.opt}`}>GP</span>
        <span className={`${styles.n} ${styles.opt}`}>PTS</span>
        <span className={`${styles.n} ${styles.opt}`}>REB</span>
        <span className={`${styles.n} ${styles.opt}`}>AST</span>
        <span className={styles.n} title="9CAT value this season">Value</span>
      </div>
      {players.map((p) => {
        const on = picked.has(p.id);
        return (
          <div key={p.id} className={`${styles.r} ${on ? styles.picked : ""}`}>
            <span>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                aria-label={`${on ? "Remove" : "Add"} ${fullName(p)}`}
                className={styles.pick}
                onClick={() => onPick(p.id)}
              >
                {on ? "✓" : ""}
              </button>
            </span>
            <span className={styles.player} onClick={() => onPick(p.id)}>
              <Avatar player={p} size={34} />
              <span className={styles.who}>
                <span className={styles.name}>
                  {fullName(p)}
                  {p.injuryStatus && (
                    <span className={`${styles.tag} ${p.injuryStatus === "Out" ? styles.out : styles.dtd}`}>{p.injuryStatus}</span>
                  )}
                  {p.inOpenTrade && <span className={styles.tag} title="Also in another open trade">In a trade</span>}
                </span>
                <span className={styles.meta}>
                  {[p.teamAbbr, p.position?.replace(/-/g, "/"), p.slot].filter(Boolean).join(" · ")}
                </span>
              </span>
            </span>
            <span className={`${styles.n} ${styles.opt}`}>{p.gp}</span>
            <span className={`${styles.n} ${styles.opt}`}>{p.stats ? fmtAvg(p.stats.pts) : "–"}</span>
            <span className={`${styles.n} ${styles.opt}`}>{p.stats ? fmtAvg(p.stats.reb) : "–"}</span>
            <span className={`${styles.n} ${styles.opt}`}>{p.stats ? fmtAvg(p.stats.ast) : "–"}</span>
            <span className={styles.n}>{p.value === null ? "–" : fmtValue(p.value)}</span>
          </div>
        );
      })}
    </section>
  );
}

function Chips({ players, empty }: { players: TradeRosterPlayer[]; empty: string }) {
  return (
    <div className={styles.chips}>
      {players.length === 0 ? (
        <span className={styles.none}>{empty}</span>
      ) : (
        players.map((p) => (
          <span key={p.id} className={styles.chip}>
            <Avatar player={p} size={24} />
            {fullName(p)}
          </span>
        ))
      )}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <SiteHeader />
        {children}
      </div>
    </div>
  );
}

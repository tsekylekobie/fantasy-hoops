"use client";

// Trade builder (/team/[id]/trade): your roster and theirs side by side. Tick
// the players you'd send and the ones you want, add a note, and propose. The
// other manager accepts or rejects it from their My team page; then the league
// reviews it (see TradesPanel). Rosters come from GET /api/trades/builder; the
// analyzer below them (TradeAnalysis) re-prices every pick from
// GET /api/trades/analysis. Going over the active limit means picking drops,
// which go through with the trade.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Avatar from "@/components/Avatar";
import TradeAnalysis, { AnalysisControls } from "@/components/trades/TradeAnalysis";
import SiteHeader from "@/components/SiteHeader";
import { fetchJson, fmtAvg, fmtGameDate, fmtValue, fullName } from "@/components/players/format";
import { playerValue, type WeightSet } from "@/lib/trades/analysis";
import type {
  Trade, TradeAnalysisPlayer, TradeAnalysisResponse, TradeBuilderResponse, TradeProposal, TradeRosterPlayer, TradeWindow,
} from "@/lib/types";
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
  const [drops, setDrops] = useState<number[]>([]);
  const [analysis, setAnalysis] = useState<TradeAnalysisResponse | null>(null);
  const [statWindow, setStatWindow] = useState<TradeWindow>("season");
  const [weights, setWeights] = useState<WeightSet>("mine");
  const [tab, setTab] = useState<"players" | "analysis">("players");
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

  const myTeamId = data?.myTeam.id;
  useEffect(() => {
    if (myTeamId === undefined) return;
    const ctrl = new AbortController();
    // The analyzer is extra: without it the builder still works.
    fetchJson<TradeAnalysisResponse>(`/api/trades/analysis?teams=${myTeamId},${partnerId}`, ctrl.signal)
      .then(setAnalysis)
      .catch(() => {});
    return () => ctrl.abort();
  }, [myTeamId, partnerId]);

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
  // Over the limit: you pick drops (they go through with the trade); they pick theirs when accepting.
  const mustDrop = myAfter > settings.activeLimit && myAfter > myNow ? myAfter - settings.activeLimit : 0;
  const droppable = new Set(myTeam.players.filter((p) => isActive(p) && !send.has(p.id)).map((p) => p.id));
  const myDrops = drops.filter((id) => droppable.has(id)).slice(0, mustDrop);
  const theyDrop = theirAfter > settings.activeLimit && theirAfter > theirNow ? theirAfter - settings.activeLimit : 0;
  const notes = [
    mustDrop > myDrops.length
      ? `You'd have ${myAfter} active players (limit ${settings.activeLimit}). Pick ${mustDrop - myDrops.length} to drop under Trade analysis, or send more.`
      : null,
    theyDrop > 0 ? `${partner.name} would have ${theirAfter} active players (limit ${settings.activeLimit}); they'd drop ${theyDrop} when accepting.` : null,
  ].filter(Boolean) as string[];
  const pastDeadline = settings.deadline !== null && data.today > settings.deadline;
  const ready = sending.length > 0 && receiving.length > 0 && myDrops.length === mustDrop && !pastDeadline;
  const dropNames = myTeam.players.filter((p) => myDrops.includes(p.id));
  // The rosters' stats and value follow the analyzer's switches once it has loaded.
  const lineFor = (p: TradeRosterPlayer) => {
    const a = analysis?.teams.flatMap((t) => t.players).find((x) => x.id === p.id);
    return a ? analyzed(a, statWindow, weights) : null;
  };

  async function propose() {
    setSaving(true);
    setError(null);
    try {
      const body: TradeProposal = {
        partnerTeamId: partner.id,
        sendPlayerIds: [...send],
        receivePlayerIds: [...receive],
        dropPlayerIds: myDrops.length > 0 ? myDrops : undefined,
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
        Pick players from each roster; the analysis below updates as you go. {partner.name} can accept or reject your
        offer. {review}
      </p>
      {pastDeadline && (
        <div className={`${styles.note} ${styles.error}`} role="alert"><p>The trade deadline ({settings.deadline}) has passed.</p></div>
      )}

      <div className={styles.phoneTabs} role="group" aria-label="Show">
        {(["players", "analysis"] as const).map((t) => (
          <button key={t} type="button" className={tab === t ? styles.on : undefined} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t === "players" ? "Players" : "Analysis"}
          </button>
        ))}
      </div>

      {analysis && (
        <div className={styles.toolbar}>
          <AnalysisControls data={analysis} statWindow={statWindow} weights={weights} onWindow={setStatWindow} onWeights={setWeights} />
          {statWindow === "last14" && analysis.last14 && (
            <span className={styles.when}>{fmtGameDate(analysis.last14.from)} – {fmtGameDate(analysis.last14.to)}</span>
          )}
        </div>
      )}

      <div className={`${styles.cols} ${tab === "players" ? "" : styles.phoneOff}`}>
        <Roster
          title="You send"
          team={myTeam.name}
          players={myTeam.players}
          picked={send}
          dropping={new Set(myDrops)}
          lineFor={lineFor}
          onPick={(id) => toggle(send, setSend, id)}
        />
        <Roster
          title="You receive"
          team={partner.name}
          players={partner.players}
          picked={receive}
          dropping={new Set()}
          lineFor={lineFor}
          onPick={(id) => toggle(receive, setReceive, id)}
        />
      </div>

      {analysis && (
        <div className={tab === "analysis" ? "" : styles.phoneOff}>
          <TradeAnalysis
            data={analysis}
            sides={[
              { teamId: myTeam.id, out: [...send], drops: myDrops, dropMode: "pick" },
              { teamId: partner.id, out: [...receive], drops: [], dropMode: "assume" },
            ]}
            viewerTeamId={myTeam.id}
            statWindow={statWindow}
            weights={weights}
            onDrops={(_, ids) => setDrops(ids)}
          />
        </div>
      )}

      <section className={styles.summary} aria-label="Trade summary">
        <div className={styles.gets}>
          <p className={styles.label}>{partner.name} gets</p>
          <Chips players={sending} empty="Pick players from your roster" />
        </div>
        <div className={styles.gets}>
          <p className={styles.label}>You get</p>
          <Chips players={receiving} empty={`Pick players from ${partner.name}`} />
        </div>
        {dropNames.length > 0 && (
          <div className={`${styles.gets} ${styles.wide}`}>
            <p className={styles.label}>You drop when it goes through</p>
            <Chips players={dropNames} empty="" />
          </div>
        )}
        <label className={styles.noteField}>
          Note to {partner.name} (optional)
          <textarea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Pitch your offer…" />
        </label>
        {notes.map((t) => (
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

/** A player's GP, PTS/REB/AST and value in the analyzer's window and weights. */
function analyzed(p: TradeAnalysisPlayer, window: TradeWindow, weights: WeightSet) {
  const l = p[window];
  return { gp: l?.gp ?? 0, pts: l?.perGame.pts ?? null, reb: l?.perGame.reb ?? null, ast: l?.perGame.ast ?? null, value: l ? playerValue(p, window, weights) : null };
}

function Roster({ title, team, players, picked, dropping, lineFor, onPick }: {
  title: string;
  team: string;
  players: TradeRosterPlayer[];
  picked: Set<number>;
  dropping: Set<number>;
  lineFor: (p: TradeRosterPlayer) => ReturnType<typeof analyzed> | null;
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
        <span className={styles.n} title="9CAT value, with the analyzer's window and weights">Value</span>
      </div>
      {players.map((p) => {
        const on = picked.has(p.id);
        const a = lineFor(p);
        const line = a ?? {
          gp: p.gp, pts: p.stats?.pts ?? null, reb: p.stats?.reb ?? null, ast: p.stats?.ast ?? null, value: p.value,
        };
        return (
          <div key={p.id} className={`${styles.r} ${on ? styles.picked : ""} ${dropping.has(p.id) ? styles.dropping : ""}`}>
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
                  {p.injury && (
                    <span className={`${styles.tag} ${p.injury.status === "Out" ? styles.out : styles.dtd}`}>{p.injury.status}</span>
                  )}
                  {p.inOpenTrade && <span className={styles.tag} title="Also in another open trade">In a trade</span>}
                  {dropping.has(p.id) && <span className={`${styles.tag} ${styles.out}`}>Drop</span>}
                </span>
                <span className={styles.meta}>
                  {[p.teamAbbr, p.position?.replace(/-/g, "/"), p.slot].filter(Boolean).join(" · ")}
                </span>
              </span>
            </span>
            <span className={`${styles.n} ${styles.opt}`}>{line.gp}</span>
            <span className={`${styles.n} ${styles.opt}`}>{line.pts === null ? "–" : fmtAvg(line.pts)}</span>
            <span className={`${styles.n} ${styles.opt}`}>{line.reb === null ? "–" : fmtAvg(line.reb)}</span>
            <span className={`${styles.n} ${styles.opt}`}>{line.ast === null ? "–" : fmtAvg(line.ast)}</span>
            <span className={styles.n}>{line.value === null ? "–" : fmtValue(line.value)}</span>
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

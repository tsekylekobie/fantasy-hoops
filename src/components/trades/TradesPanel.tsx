"use client";

// Open trades and the latest finished ones, from GET /api/trades, with the
// actions the signed-in manager can take: accept or reject an offer, cancel
// their own, vote to veto (league vote) or veto (commissioner) during review.
// "mine" (on /my-team) shows open trades plus your recent ones, and hides
// itself when there's nothing; "league" (on /league) shows everything visible.
// Each open trade can show the trade analyzer (TradeAnalysis), open by default
// on an offer you received; there you pick your drops before accepting when
// the trade would put you over the active limit.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Avatar from "@/components/Avatar";
import { fetchJson, fmtGameDate, fullName } from "@/components/players/format";
import TradeAnalysis, { AnalysisControls, type AnalysisSide } from "@/components/trades/TradeAnalysis";
import { analyzeTrade, type WeightSet } from "@/lib/trades/analysis";
import type {
  FantasyTeamSummary, PlayerSummary, Trade, TradeAction, TradeActionRequest, TradeAnalysisResponse, TradesResponse, TradeWindow,
} from "@/lib/types";
import TeamBadge from "@/components/TeamBadge";
import styles from "./Trades.module.css";

const STATE_TEXT: Record<Trade["status"], string> = {
  offered: "Offered",
  review: "In review",
  completed: "Completed",
  rejected: "Rejected",
  cancelled: "Cancelled",
  vetoed: "Vetoed",
  failed: "Failed",
};

/** "1d 4h left in review", "2d left in review", "3h left in review" */
function timeLeft(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "Review over; processes once its players unlock";
  const h = Math.ceil(ms / 3_600_000);
  const left = h < 24 ? `${h}h` : h % 24 === 0 ? `${h / 24}d` : `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${left} left in review`;
}

const reviewText = (d: TradesResponse) => {
  const s = d.settings;
  if (s.review === "none") return "Trades process as soon as they're accepted";
  const window = `${s.reviewDays}-day review`;
  return s.review === "league_vote" ? `${window} · ${s.vetoVotes} veto votes kill a trade` : `${window} · commissioner can veto`;
};

async function postAction(id: number, action: TradeAction, dropPlayerIds: number[]): Promise<Trade> {
  const body: TradeActionRequest = action === "accept" && dropPlayerIds.length > 0 ? { action, dropPlayerIds } : { action };
  const res = await fetch(`/api/trades/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (Trade & { error?: string }) | null;
  if (!res.ok || !json) throw new Error(json?.error || `Request failed (${res.status}).`);
  return json;
}

const DONE_TEXT: Record<TradeAction, string> = {
  accept: "Trade accepted.",
  reject: "Offer rejected.",
  cancel: "Offer cancelled.",
  vote: "Veto vote cast.",
  unvote: "Veto vote removed.",
  veto: "Trade vetoed.",
};

export default function TradesPanel({ scope }: { scope: "mine" | "league" }) {
  const [data, setData] = useState<TradesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    fetchJson<TradesResponse>("/api/trades", signal ?? new AbortController().signal)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!signal?.aborted) setError(err instanceof Error ? err.message : "Couldn't load trades.");
      });
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  async function act(t: Trade, action: TradeAction, drops: number[] = []) {
    if (action === "veto" && !window.confirm("Veto this trade? It can't be undone.")) return;
    setBusy(t.id);
    setNote(null);
    try {
      const next = await postAction(t.id, action, drops);
      const text = action === "accept" && next.status === "completed" ? "Trade accepted and processed." : DONE_TEXT[action];
      setNote({ kind: "ok", text: next.status === "vetoed" && action === "vote" ? `${text} That was enough to veto it.` : text });
    } catch (err) {
      setNote({ kind: "error", text: err instanceof Error ? err.message : "Something went wrong." });
    } finally {
      setBusy(null);
      load();
    }
  }

  if (!data) {
    if (scope === "mine") return null;
    return (
      <section className={`${styles.card} ${styles.panel}`}>
        <h3>Trades</h3>
        <p className={styles.empty}>{error ?? "Loading trades…"}</p>
      </section>
    );
  }

  const recent = scope === "mine" ? data.recent.filter((t) => t.role === "proposer" || t.role === "partner") : data.recent;
  if (scope === "mine" && (!data.myTeam || (data.open.length === 0 && recent.length === 0))) return null;

  return (
    <section className={`${styles.card} ${styles.panel}`} id="trades" aria-label="Trades">
      <h3>
        {scope === "mine" ? "Trades" : "League trades"}
        <span className={styles.when}>{reviewText(data)}</span>
      </h3>
      {note && (
        <div className={`${styles.note} ${note.kind === "ok" ? styles.ok : styles.error}`} role={note.kind === "ok" ? "status" : "alert"}>
          <p>{note.text}</p>
        </div>
      )}
      {data.open.length === 0 ? (
        <p className={styles.empty}>No open trades.</p>
      ) : (
        data.open.map((t) => (
          <TradeCard key={t.id} t={t} data={data} busy={busy === t.id} onAct={(a, drops) => void act(t, a, drops)} />
        ))
      )}
      {recent.length > 0 && (
        <>
          <div className={styles.recentHead}>Recent</div>
          {recent.map((t) => <RecentRow key={t.id} t={t} myTeam={data.myTeam} />)}
        </>
      )}
      <p className={styles.foot}>
        Offers are private to the two teams until accepted. Players move to the bench of their new team when a trade
        processes; a trade waits for tomorrow if any of its players has already tipped off today.
        {scope === "league" && data.myTeam && " Start a trade from another team's page."}
      </p>
    </section>
  );
}

const teamHref = (t: FantasyTeamSummary, mine: FantasyTeamSummary | null) => (t.id === mine?.id ? "/my-team" : `/team/${t.id}`);

function TeamName({ t, mine }: { t: FantasyTeamSummary; mine: FantasyTeamSummary | null }) {
  return (
    <>
      <TeamBadge team={t} />
      <Link className={styles.teamLink} href={teamHref(t, mine)}>{t.id === mine?.id ? "You" : t.name}</Link>
    </>
  );
}

function Players({ players }: { players: PlayerSummary[] }) {
  return (
    <div className={styles.chips}>
      {players.map((p) => (
        <span key={p.id} className={styles.chip}>
          <Avatar player={p} size={24} />
          {fullName(p)}
          <span className={styles.none}>{p.teamAbbr ?? ""}</span>
        </span>
      ))}
    </div>
  );
}

function TradeCard({ t, data, busy, onAct }: {
  t: Trade; data: TradesResponse; busy: boolean; onAct: (a: TradeAction, drops?: number[]) => void;
}) {
  const mine = data.myTeam;
  const [open, setOpen] = useState(t.can.accept);
  const [analysis, setAnalysis] = useState<TradeAnalysisResponse | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [statWindow, setStatWindow] = useState<TradeWindow>("season");
  const [weights, setWeights] = useState<WeightSet>("mine");
  const [drops, setDrops] = useState<number[]>([]);

  useEffect(() => {
    if (!open || analysis) return;
    const ctrl = new AbortController();
    fetchJson<TradeAnalysisResponse>(`/api/trades/analysis?teams=${t.proposer.id},${t.partner.id}`, ctrl.signal)
      .then(setAnalysis)
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) setAnalysisError(err instanceof Error ? err.message : "Couldn't load the analysis.");
      });
    return () => ctrl.abort();
  }, [open, analysis, t.proposer.id, t.partner.id]);

  // The partner picks drops while answering; recorded drops are fixed; otherwise they're assumed.
  const proposerSide: AnalysisSide = {
    teamId: t.proposer.id, out: t.sends.map((p) => p.id), drops: t.proposerDrops.map((p) => p.id),
    dropMode: t.proposerDrops.length > 0 ? "fixed" : "assume",
  };
  const partnerSide: AnalysisSide = t.can.accept
    ? { teamId: t.partner.id, out: t.receives.map((p) => p.id), drops, dropMode: "pick" }
    : { teamId: t.partner.id, out: t.receives.map((p) => p.id), drops: t.partnerDrops.map((p) => p.id), dropMode: t.partnerDrops.length > 0 ? "fixed" : "assume" };
  const sides: [AnalysisSide, AnalysisSide] = t.role === "partner" ? [partnerSide, proposerSide] : [proposerSide, partnerSide];
  const mustDrop = t.can.accept && analysis ? analyzeTrade(analysis, sides, statWindow, weights)[0].mustDrop : 0;
  const myDrops = drops.slice(0, mustDrop);
  const needDrops = mustDrop - myDrops.length;
  const involved = t.role === "proposer" || t.role === "partner";
  const getsName = (team: FantasyTeamSummary) => (team.id === mine?.id ? "You get" : `${team.name} gets`);
  let status = "";
  if (t.status === "offered") {
    status = t.role === "partner" ? `${t.proposer.name} offered you this trade.` : `Waiting on ${t.partner.name}.`;
  } else {
    status = timeLeft(t.processAt);
  }
  const vetoes = data.settings.review === "league_vote" && t.status === "review";
  return (
    <article className={`${styles.trade} ${involved ? styles.mine : ""}`} aria-label={`Trade ${t.proposer.name} and ${t.partner.name}`}>
      <div className={styles.tradeHead}>
        <span className={styles.teams}>
          <TeamName t={t.proposer} mine={mine} />
          <span className={styles.swap} aria-label="trading with">⇄</span>
          <TeamName t={t.partner} mine={mine} />
        </span>
        <span className={`${styles.state} ${styles[`s_${t.status}`]}`}>{STATE_TEXT[t.status]}</span>
      </div>
      <div className={styles.sides}>
        <div>
          <p className={`${styles.label}`}>{getsName(t.partner)}</p>
          <Players players={t.sends} />
        </div>
        <div>
          <p className={`${styles.label}`}>{getsName(t.proposer)}</p>
          <Players players={t.receives} />
        </div>
      </div>
      {(t.proposerDrops.length > 0 || t.partnerDrops.length > 0) && (
        <div className={styles.sides}>
          {t.proposerDrops.length > 0 && (
            <div>
              <p className={styles.label}>{t.proposer.id === mine?.id ? "You drop" : `${t.proposer.name} drops`}</p>
              <Players players={t.proposerDrops} />
            </div>
          )}
          {t.partnerDrops.length > 0 && (
            <div>
              <p className={styles.label}>{t.partner.id === mine?.id ? "You drop" : `${t.partner.name} drops`}</p>
              <Players players={t.partnerDrops} />
            </div>
          )}
        </div>
      )}
      {t.note && <p className={styles.tradeNote}>“{t.note}”</p>}
      <div className={styles.tradeFoot}>
        <span className={styles.votes}>
          {status}
          {vetoes && (
            <>
              <span className={styles.meter} aria-hidden="true">
                {Array.from({ length: data.settings.vetoVotes }, (_, i) => (
                  <span key={i} className={i < t.vetoVotes ? styles.hit : undefined} />
                ))}
              </span>
              <span>{t.vetoVotes} of {data.settings.vetoVotes} veto votes</span>
            </>
          )}
        </span>
        <span className={styles.btns}>
          {t.can.reject && <button type="button" className={styles.btn} disabled={busy} onClick={() => onAct("reject")}>Reject</button>}
          {mine && (
            <button type="button" className={styles.btn} aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "Hide analysis" : "Analyze"}
            </button>
          )}
          {t.can.accept && (
            <button
              type="button"
              className={`${styles.btn} ${styles.primary}`}
              disabled={busy || needDrops > 0}
              title={needDrops > 0 ? `Pick ${needDrops} to drop in the analysis first` : undefined}
              onClick={() => onAct("accept", myDrops)}
            >
              Accept
            </button>
          )}
          {t.can.cancel && <button type="button" className={styles.btn} disabled={busy} onClick={() => onAct("cancel")}>Cancel offer</button>}
          {t.can.vote && (
            <button
              type="button"
              className={`${styles.btn} ${t.myVote ? styles.on : ""}`}
              aria-pressed={t.myVote}
              disabled={busy}
              onClick={() => onAct(t.myVote ? "unvote" : "vote")}
            >
              {t.myVote ? "Vetoed · undo" : "Vote to veto"}
            </button>
          )}
          {t.can.veto && (
            <button type="button" className={`${styles.btn} ${styles.danger}`} disabled={busy} onClick={() => onAct("veto")}>Veto</button>
          )}
        </span>
      </div>
      {t.can.accept && needDrops > 0 && (
        <div className={`${styles.note} ${styles.warn} ${styles.analyze}`}>
          <p>Accepting would put you over the active limit: pick {needDrops} to drop below. They go when the trade goes through.</p>
        </div>
      )}
      {open && (
        <div className={styles.analyze}>
          {analysis ? (
            <TradeAnalysis
              data={analysis}
              sides={sides}
              viewerTeamId={t.role === "proposer" || t.role === "partner" ? mine?.id ?? null : null}
              statWindow={statWindow}
              weights={weights}
              onDrops={(_, ids) => setDrops(ids)}
              intro={t.role === "league" ? "You’re not in this trade; values use your weights." : undefined}
              controls={
                <AnalysisControls data={analysis} statWindow={statWindow} weights={weights} onWindow={setStatWindow} onWeights={setWeights} />
              }
            />
          ) : (
            <p className={styles.empty}>{analysisError ?? "Loading the analysis…"}</p>
          )}
        </div>
      )}
    </article>
  );
}

function RecentRow({ t, myTeam }: { t: Trade; myTeam: FantasyTeamSummary | null }) {
  const names = (ps: PlayerSummary[]) => ps.map((p) => `${p.firstName.charAt(0)}. ${p.lastName}`).join(", ");
  const short = (team: FantasyTeamSummary) => (team.id === myTeam?.id ? "You" : team.abbreviation);
  const date = (t.closedAt ?? t.createdAt).slice(0, 10);
  return (
    <div className={styles.recent} title={t.reason ?? undefined}>
      <span className={styles.date}>{fmtGameDate(date)}</span>
      <span className={styles.what}>
        <b>{short(t.proposer)}</b> get {names(t.receives)} · <b>{short(t.partner)}</b> get {names(t.sends)}
        {t.reason && <span className={styles.none}> · {t.reason}</span>}
      </span>
      <span className={`${styles.state} ${styles[`s_${t.status}`]}`}>{STATE_TEXT[t.status]}</span>
    </div>
  );
}

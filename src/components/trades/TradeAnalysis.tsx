"use client";

// The trade analyzer (docs/design/trade-analyzer.mockup.html): what a trade does
// to both teams. Each team's per-game category totals now and after, where
// they'd rank in the league, the value change with the viewer's punt weights,
// and the roster consequences: drops to fit the active limit and the best
// lineup after (empty slots are positional holes). The numbers come from
// src/lib/trades/analysis.ts over GET /api/trades/analysis; used by the trade
// builder and by pending trades in TradesPanel.
import { useState } from "react";
import { fmtAvg, fmtPct, fmtValue, fullName } from "@/components/players/format";
import { analyzeTrade, playerValue, type CategoryChange, type SideAnalysis, type TradeSideInput, type WeightSet } from "@/lib/trades/analysis";
import { CATEGORIES, type Category, type CategoryWeights, type TradeAnalysisResponse, type TradeWindow } from "@/lib/types";
import styles from "./TradeAnalysis.module.css";

const LABEL: Record<Category, string> = {
  fgPct: "FG%", ftPct: "FT%", fg3m: "3PM", pts: "PTS", reb: "REB", ast: "AST", stl: "STL", blk: "BLK", tov: "TO",
};

/** How a side's drops are decided: picked here, already recorded on the trade, or not yet (assumed lowest value). */
export type DropMode = "pick" | "fixed" | "assume";

export interface AnalysisSide extends TradeSideInput {
  dropMode: DropMode;
}

/** "Punt FT%" / "Punt FT%, TO" / "Custom". */
export function weightsLabel(w: CategoryWeights): string {
  const punted = CATEGORIES.filter((c) => w[c] === 0).map((c) => LABEL[c]);
  return punted.length > 0 ? `Punt ${punted.join(", ")}` : "Custom";
}

const isPct = (k: Category) => k === "fgPct" || k === "ftPct";
const fmtCat = (k: Category, v: number | null) => (v === null ? "—" : isPct(k) ? fmtPct(v) : fmtAvg(v));

function fmtChange(c: CategoryChange): string {
  if (c.before === null || c.after === null || c.better === null) return "—";
  const d = Math.abs(c.after - c.before);
  const s = isPct(c.key) ? fmtPct(d) : fmtAvg(d);
  if (s === "0.0" || s === ".000") return "—";
  return `${c.better ? "▲" : "▼"} ${c.after > c.before ? "+" : "−"}${s}`;
}

const changeClass = (c: CategoryChange) => (fmtChange(c) === "—" ? styles.even : c.better ? styles.up : styles.down);

const signed = (v: number) => (Math.abs(v) < 0.005 ? "0.00" : v > 0 ? `+${v.toFixed(2)}` : fmtValue(v));
const signClass = (v: number) => (Math.abs(v) < 0.005 ? styles.even : v > 0 ? styles.up : styles.down);

function ordinal(n: number): string {
  const v = n % 100;
  const s = v >= 11 && v <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${s}`;
}

const tier = (r: number) => (r <= 3 ? styles.t1 : r <= 6 ? styles.t2 : r <= 9 ? styles.t3 : styles.t4);

function Rank({ c }: { c: CategoryChange }) {
  return (
    <span className={styles.rank} aria-label={`${ordinal(c.rankBefore)} now, ${ordinal(c.rankAfter)} after`}>
      <i className={`${styles.rk} ${styles.was} ${tier(c.rankBefore)}`}>{c.rankBefore}</i>
      <span aria-hidden="true">→</span>
      <i className={`${styles.rk} ${tier(c.rankAfter)}`}>{c.rankAfter}</i>
    </span>
  );
}

/** The Season / Last 14 days and Your weights / Default switches, shared with the builder's toolbar. */
export function AnalysisControls({ data, statWindow, weights, onWindow, onWeights }: {
  data: TradeAnalysisResponse;
  statWindow: TradeWindow;
  weights: WeightSet;
  onWindow: (w: TradeWindow) => void;
  onWeights: (w: WeightSet) => void;
}) {
  return (
    <div className={styles.controls}>
      <div className={styles.seg} role="group" aria-label="Stats window">
        {(["season", "last14"] as const).map((w) => (
          <button key={w} type="button" className={statWindow === w ? styles.on : undefined} aria-pressed={statWindow === w} onClick={() => onWindow(w)}>
            {w === "season" ? "Season" : "Last 14 days"}
          </button>
        ))}
      </div>
      {!data.weightsAreDefault && (
        <div className={styles.seg} role="group" aria-label="Value weights">
          {(["mine", "default"] as const).map((w) => (
            <button key={w} type="button" className={weights === w ? styles.on : undefined} aria-pressed={weights === w} onClick={() => onWeights(w)}>
              {w === "mine" ? <>Your weights <small>{weightsLabel(data.weights)}</small></> : "Default"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  data: TradeAnalysisResponse;
  /** The two teams, in display order (the viewer's first when in the trade). */
  sides: [AnalysisSide, AnalysisSide];
  /** The viewer's team, for "(you)"; null when not in the trade. */
  viewerTeamId: number | null;
  statWindow: TradeWindow;
  weights: WeightSet;
  onDrops?: (teamId: number, ids: number[]) => void;
  /** Rendered in the header (the pending-trade view carries its own switches). */
  controls?: React.ReactNode;
  intro?: string;
}

export default function TradeAnalysis({ data, sides, viewerTeamId, statWindow, weights, onDrops, controls, intro }: Props) {
  const [phoneSide, setPhoneSide] = useState(0);
  const result = analyzeTrade(data, sides, statWindow, weights);
  const name = (teamId: number) => data.teams.find((t) => t.id === teamId)?.name ?? "Team";
  const title = (teamId: number) => `${name(teamId)}${teamId === viewerTeamId ? " (you)" : ""}`;
  const weightName = weights === "mine" && !data.weightsAreDefault ? `your weights (${weightsLabel(data.weights)})` : "default weights";
  const windowName = statWindow === "season" ? "season averages" : "the last 14 days";

  return (
    <section className={styles.an} aria-label="Trade analysis">
      <div className={styles.head}>
        <div>
          <h2>Trade analysis</h2>
          <p>
            {intro ? `${intro} ` : ""}Each team’s per-game category totals now and after the trade, from {windowName}, and
            where they’d rank in the league.
          </p>
        </div>
        {controls}
      </div>

      <div className={styles.tiles}>
        {result.map((s, i) => (
          <Tile key={s.teamId} s={s} title={title(s.teamId)} you={s.teamId === viewerTeamId} weightName={weightName} hidePhone={i !== phoneSide} />
        ))}
      </div>

      <div className={styles.phoneSwitch} role="group" aria-label="Team">
        {result.map((s, i) => (
          <button key={s.teamId} type="button" className={phoneSide === i ? styles.on : undefined} aria-pressed={phoneSide === i} onClick={() => setPhoneSide(i)}>
            {s.teamId === viewerTeamId ? "You" : name(s.teamId)}
          </button>
        ))}
      </div>

      {/* Wide: both teams side by side. */}
      <div className={styles.scroll}>
        <div className={styles.table} role="table" aria-label="Category totals before and after">
          <div className={`${styles.tr} ${styles.teamsRow}`} role="row">
            <span />
            {result.map((s) => (
              <span key={s.teamId} className={`${styles.span4} ${s.teamId === viewerTeamId ? styles.youHead : ""}`} role="columnheader">
                {title(s.teamId)}
              </span>
            ))}
          </div>
          <div className={`${styles.tr} ${styles.h}`} role="row">
            <span role="columnheader">Cat</span>
            {result.map((s) => (
              <Cols key={s.teamId}>
                <span className={styles.n}>Before</span>
                <span className={styles.n}>After</span>
                <span className={styles.n}>Change</span>
                <span className={styles.c}>League rank</span>
              </Cols>
            ))}
          </div>
          {CATEGORIES.map((k, i) => (
            <div key={k} className={styles.tr} role="row">
              <span className={styles.cat} role="rowheader">{LABEL[k]}</span>
              {result.map((s) => {
                const c = s.categories[i];
                return (
                  <Cols key={s.teamId}>
                    <span className={styles.n}>{fmtCat(k, c.before)}</span>
                    <span className={`${styles.n} ${styles.after}`}>{fmtCat(k, c.after)}</span>
                    <span className={`${styles.n} ${styles.change} ${changeClass(c)}`}>{fmtChange(c)}</span>
                    <Rank c={c} />
                  </Cols>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Phone: one team at a time. */}
      <div className={styles.phoneList}>
        <div className={`${styles.pc} ${styles.h}`}>
          <span>Cat</span><span>After · was</span><span className={styles.n}>Change</span><span className={styles.n}>Rank</span>
        </div>
        {result[phoneSide].categories.map((c) => (
          <div key={c.key} className={styles.pc}>
            <span className={styles.cat}>{LABEL[c.key]}</span>
            <span className={styles.vv}><b>{fmtCat(c.key, c.after)}</b><small>was {fmtCat(c.key, c.before)}</small></span>
            <span className={`${styles.n} ${styles.change} ${changeClass(c)}`}>{fmtChange(c)}</span>
            <Rank c={c} />
          </div>
        ))}
      </div>

      <p className={styles.foot}>
        Per-game team totals: every active player’s averages added up (arrivals included, IL left out), with FG% and FT%
        from summed makes and attempts. League rank is against all {data.league.length} teams; TO counts fewer as better.
        Value is the Players page’s 9CAT value with {weightName}, summed over the roster.
      </p>

      <div className={styles.cons}>
        {result.map((s, i) => (
          <Consequences
            key={s.teamId}
            s={s}
            side={sides[i]}
            data={data}
            hidePhone={i !== phoneSide}
            title={title(s.teamId)}
            teamName={name(s.teamId)}
            you={s.teamId === viewerTeamId}
            weightName={weightName}
            value={(p) => playerValue(p, statWindow, weights)}
            onDrops={onDrops}
          />
        ))}
      </div>
    </section>
  );
}

function Cols({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function Tile({ s, title, you, weightName, hidePhone }: {
  s: SideAnalysis; title: string; you: boolean; weightName: string; hidePhone: boolean;
}) {
  const up = s.categories.filter((c) => c.rankAfter < c.rankBefore).map((c) => LABEL[c.key]);
  const down = s.categories.filter((c) => c.rankAfter > c.rankBefore).map((c) => LABEL[c.key]);
  const dv = s.valueAfter - s.valueBefore;
  return (
    <div className={`${styles.tile} ${you ? styles.you : ""} ${hidePhone ? styles.phoneHidden : ""}`}>
      <p className={styles.lbl}>{title}</p>
      <div className={styles.tv}>
        <b className={signClass(dv)}>{signed(dv)}</b>
        <span>value with {weightName}<br />{fmtValue(s.valueBefore)} → {fmtValue(s.valueAfter)} across the roster</span>
      </div>
      <p className={styles.vd}>
        <span className={styles.up}>▲ {up.length} ranks up</span>
        <span className={styles.down}>▼ {down.length} down</span>
        <span className={styles.even}>{9 - up.length - down.length} same</span>
      </p>
      <p className={styles.gl}><b>Up:</b> {up.join(", ") || "none"} · <b>Down:</b> {down.join(", ") || "none"}</p>
    </div>
  );
}

function Consequences({ s, side, data, hidePhone, title, teamName, you, weightName, value, onDrops }: {
  s: SideAnalysis;
  side: AnalysisSide;
  data: TradeAnalysisResponse;
  hidePhone: boolean;
  title: string;
  teamName: string;
  you: boolean;
  weightName: string;
  value: (p: SideAnalysis["out"][number]) => number;
  onDrops?: (teamId: number, ids: number[]) => void;
}) {
  const dv = s.valueAfter - s.valueBefore;
  const limit = data.activeLimit;
  const subject = you ? "You’d have" : `${teamName} would have`;
  const dropNames = s.drops.map((d) => fullName(d.player)).join(", ");
  const picking = side.dropMode === "pick" && s.mustDrop > 0 && onDrops !== undefined;
  const incomingIds = new Set(s.incoming.map((p) => p.id));
  const empty = s.lineup.filter((x) => !x.player).map((x) => x.slot);

  let spots: { text: string; kind: "plain" | "warn" | "ok" };
  if (s.mustDrop > 0 && side.dropMode === "fixed" && s.drops.every((d) => !d.assumed)) {
    spots = { text: `${teamName} drops ${dropNames} when it goes through.`, kind: "plain" };
  } else if (s.mustDrop > 0 && picking) {
    spots = { text: `${subject} ${s.activeAfter} active players (limit ${limit}). Pick ${s.mustDrop} to drop when the trade goes through.`, kind: "warn" };
  } else if (s.mustDrop > 0) {
    spots = {
      text: `${subject} ${s.activeAfter} active players (limit ${limit}) and must drop ${s.mustDrop} to accept. ` +
        `They pick when accepting; the numbers assume ${dropNames}, their lowest value.`,
      kind: "warn",
    };
  } else if (s.activeAfter < limit) {
    const open = limit - s.activeAfter;
    spots = { text: `${subject} ${s.activeAfter} of ${limit} active players: ${open} open spot${open > 1 ? "s" : ""} for a free agent.`, kind: "ok" };
  } else {
    spots = { text: `${you ? "You stay" : `${teamName} stays`} at ${s.activeAfter} of ${limit} active players.`, kind: "plain" };
  }

  let hole = "";
  if (empty.length > 0) {
    const centers = s.positions.find((p) => p.group === "C");
    hole = `${empty.length === 1 ? "One starting slot" : `${empty.length} starting slots`} left empty (${empty.join(", ")})`;
    if (empty.includes("C") && centers) {
      hole += centers.after === 0 ? ": nobody left can play C." : `: only ${centers.after} C-eligible for ${centers.needed} C slot${centers.needed > 1 ? "s" : ""}.`;
    } else hole += ".";
    if (s.emptyBefore === 0) hole += " Today every slot is filled.";
  }

  // Droppable: active players it keeps, lowest value first.
  const candidates = data.teams.find((t) => t.id === s.teamId)!.players
    .filter((p) => p.slot !== "IL" && p.slot !== "IL+" && !side.out.includes(p.id))
    .sort((a, b) => value(a) - value(b));
  const picked = new Set(side.drops);
  const assumed = new Set(s.drops.filter((d) => d.assumed).map((d) => d.player.id));
  const toggle = (id: number) => {
    if (!onDrops) return;
    let next = side.drops.filter((x) => x !== id);
    if (!picked.has(id)) next = [...next, id].slice(-s.mustDrop);
    onDrops(s.teamId, next);
  };

  return (
    <section className={`${styles.card} ${hidePhone ? styles.phoneHidden : ""}`} aria-label={`What changes for ${teamName}`}>
      <h3>{title}<span>{s.out.length} out · {s.incoming.length} in</span></h3>
      <div className={styles.blk}>
        <p className={styles.lbl}>Value with {weightName}</p>
        {s.out.map((p) => (
          <ValueRow key={p.id} tag="Out" tagClass={styles.tOut} name={fullName(p)} meta={meta(p)} v={-value(p)} />
        ))}
        {s.incoming.map((p) => (
          <ValueRow key={p.id} tag="In" tagClass={styles.tIn} name={fullName(p)} meta={meta(p)} v={value(p)} />
        ))}
        {s.drops.map((d) => (
          <ValueRow
            key={d.player.id}
            tag="Drop"
            tagClass={styles.tDrop}
            name={fullName(d.player)}
            meta={d.assumed ? "Lowest value · assumed" : "Dropped with the trade"}
            v={-value(d.player)}
          />
        ))}
        <div className={`${styles.br} ${styles.tot}`}><span /><span>Net</span><span className={`${styles.bv} ${signClass(dv)}`}>{signed(dv)}</span></div>
      </div>
      <div className={styles.blk}>
        <p className={styles.lbl}>Roster spots</p>
        <p className={`${styles.msg} ${spots.kind === "warn" ? styles.warn : spots.kind === "ok" ? styles.ok : ""}`}>{spots.text}</p>
        {picking && (
          <>
            <div className={styles.dropChips} role="group" aria-label="Pick who to drop">
              {candidates.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={picked.has(p.id)}
                  className={picked.has(p.id) ? styles.on : assumed.has(p.id) ? styles.assumed : undefined}
                  onClick={() => toggle(p.id)}
                >
                  {fullName(p)} <small>{fmtValue(value(p))}</small>
                </button>
              ))}
            </div>
            {assumed.size > 0 && <p className={styles.mut}>Dashed: your lowest value, assumed above until you pick.</p>}
          </>
        )}
      </div>
      <div className={styles.blk}>
        <p className={styles.lbl}>Best starting lineup after</p>
        <div className={styles.slots}>
          {s.lineup.map((x, i) => (
            <span
              key={`${x.slot}-${i}`}
              className={`${styles.sl} ${!x.player ? styles.empty : incomingIds.has(x.player.id) ? styles.new : ""}`}
              title={x.player ? fullName(x.player) : "No eligible player"}
            >
              <b>{x.slot}</b>{x.player ? x.player.lastName : "Empty"}
            </span>
          ))}
        </div>
        {hole && <p className={`${styles.msg} ${styles.warn}`}>{hole}</p>}
        <div className={styles.pos}>
          {s.positions.map((p) => (
            <span key={p.group} className={p.after < p.needed ? styles.thin : undefined} title={`${p.needed} starting slots need a ${p.group}`}>
              {p.group} <b>{p.before === p.after ? p.after : `${p.before} → ${p.after}`}</b>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

const meta = (p: SideAnalysis["out"][number]) => [p.teamAbbr, p.position?.replace(/-/g, "/")].filter(Boolean).join(" · ");

function ValueRow({ tag, tagClass, name, meta, v }: { tag: string; tagClass: string; name: string; meta: string; v: number }) {
  return (
    <div className={styles.br}>
      <span className={`${styles.bt} ${tagClass}`}>{tag}</span>
      <span className={styles.bn}>{name}<small>{meta}</small></span>
      <span className={`${styles.bv} ${signClass(v)}`}>{signed(v)}</span>
    </div>
  );
}

// The League page's Recent transactions: every completed roster move, newest
// first. Rendered by type, with a generic fallback (each player's from -> to)
// so types added later (trades, waiver claims, commissioner moves) still read.
// Each waiver run is one entry among them: the players won, expandable to every
// claim in the run (bids, drops, and why the others failed).
import Link from "next/link";
import type {
  FantasyTeamSummary,
  LeagueTransaction,
  RecentTransactions as Data,
  TransactionMove,
  WaiverRunEntry,
} from "@/lib/types";
import { fullName, teamPos } from "@/components/players/format";
import TeamBadge from "@/components/TeamBadge";
import styles from "./RecentTransactions.module.css";

const TYPE_LABELS: Record<string, string> = {
  add: "Add",
  drop: "Drop",
  add_drop: "Add / drop",
  waiver_claim: "Waiver claim",
  trade: "Trade",
  commissioner: "Commissioner move",
};

const typeLabel = (type: string) => TYPE_LABELS[type] ?? type.replace(/_/g, " ");

/** "Oct 25 · 2:48 PM" in the league's time zone. */
function fmtWhen(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  return `${day} · ${time}`;
}

const teamHref = (t: FantasyTeamSummary, myTeamId: number | null) => (t.id === myTeamId ? "/my-team" : `/team/${t.id}`);

/** How one player moved, from the acting team's point of view. */
function moveText(tx: LeagueTransaction, m: TransactionMove): { sign: "+" | "−" | "→"; verb: string } {
  if (m.to === null) return { sign: "−", verb: "Dropped" };
  if (m.from === null) {
    const verb = tx.type === "waiver_claim" ? `Claimed${tx.faabBid !== null ? ` for $${tx.faabBid}` : ""}` : "Added";
    return { sign: "+", verb: m.to.id === tx.team?.id ? verb : `${verb} to ${m.to.abbreviation}` };
  }
  return { sign: "→", verb: `${m.from.abbreviation} to ${m.to.abbreviation}` };
}

export default function RecentTransactions({ data, myTeamId }: { data: Data | null; myTeamId: number | null }) {
  if (!data) return null;
  return (
    <section className={styles.card} aria-labelledby="recent-transactions-heading">
      <h3 id="recent-transactions-heading">Recent transactions</h3>
      {data.transactions.length === 0 && data.waiverRuns.length === 0 ? (
        <p className={styles.empty}>No transactions yet. Adds, drops, claims and trades show up here.</p>
      ) : (
        <ol className={styles.list}>
          {entries(data).map((e) =>
            e.kind === "run" ? (
              <WaiverRun key={`run-${e.run.id}`} run={e.run} timeZone={data.timeZone} myTeamId={myTeamId} />
            ) : (
              <Transaction key={e.tx.id} tx={e.tx} timeZone={data.timeZone} myTeamId={myTeamId} />
            ),
          )}
        </ol>
      )}
    </section>
  );
}

function Transaction({ tx, timeZone, myTeamId }: { tx: LeagueTransaction; timeZone: string; myTeamId: number | null }) {
  return (
    <li className={`${styles.tx} ${tx.team?.id === myTeamId ? styles.mine : ""}`}>
      <div className={styles.who}>
        {tx.team ? (
          <>
            <TeamBadge team={tx.team} />
            <span className={styles.teams}>
              <span>
                <Link href={teamHref(tx.team, myTeamId)}>{tx.team.name}</Link>
                {tx.tradeTeam && (
                  <>
                    {" ⇄ "}
                    <Link href={teamHref(tx.tradeTeam, myTeamId)}>{tx.tradeTeam.name}</Link>
                  </>
                )}
              </span>
              <span className={styles.type}>{typeLabel(tx.type)}</span>
            </span>
          </>
        ) : (
          <span className={styles.teams}>
            <span className={styles.type}>{typeLabel(tx.type)}</span>
          </span>
        )}
      </div>
      <ul className={styles.moves}>
        {tx.moves.map((m) => {
          const { sign, verb } = moveText(tx, m);
          const cls = sign === "+" ? styles.plus : sign === "−" ? styles.minus : styles.across;
          return (
            <li key={m.player.id}>
              <b className={cls} aria-hidden="true">{sign}</b>
              <span className={styles.name}>{fullName(m.player)}</span>
              <span className={styles.meta}>
                {teamPos(m.player.teamAbbr, m.player.position)} · {verb}
              </span>
            </li>
          );
        })}
      </ul>
      <time className={styles.when} dateTime={tx.at}>
        {fmtWhen(tx.at, timeZone)}
      </time>
    </li>
  );
}

type Entry = { kind: "tx"; at: string; tx: LeagueTransaction } | { kind: "run"; at: string; run: WaiverRunEntry };

/** Transactions and waiver runs, newest first. */
function entries(data: Data): Entry[] {
  return [
    ...data.transactions.map((tx): Entry => ({ kind: "tx", at: tx.at, tx })),
    ...data.waiverRuns.map((run): Entry => ({ kind: "run", at: run.at, run })),
  ].sort((a, b) => b.at.localeCompare(a.at));
}

const bidText = (bid: number | null) => (bid === null ? "" : `$${bid}`);

/** One waiver run: the players won, and every claim when expanded. */
function WaiverRun({ run, timeZone, myTeamId }: { run: WaiverRunEntry; timeZone: string; myTeamId: number | null }) {
  const won = run.players.flatMap((p) => p.claims.filter((c) => c.won).map((c) => ({ player: p.player, claim: c })));
  const mine = run.players.some((p) => p.claims.some((c) => c.team.id === myTeamId));
  const total = run.won + run.failed;
  return (
    <li className={`${styles.tx} ${styles.run} ${mine ? styles.mine : ""}`}>
      <details>
        <summary className={styles.runHead}>
          <div className={styles.who}>
            <i aria-hidden="true">W</i>
            <span className={styles.teams}>
              <span>Waiver run</span>
              <span className={styles.type}>
                {run.won} won · {run.failed} failed
              </span>
            </span>
          </div>
          <ul className={styles.moves}>
            {won.length === 0 && (
              <li>
                <span className={styles.meta}>No claims went through.</span>
              </li>
            )}
            {won.map(({ player, claim }) => (
              <li key={player.id}>
                <b className={styles.plus} aria-hidden="true">+</b>
                <span className={styles.name}>{fullName(player)}</span>
                <span className={styles.meta}>
                  {claim.team.abbreviation}
                  {claim.bid !== null && ` · ${bidText(claim.bid)}`}
                </span>
              </li>
            ))}
            <li className={styles.toggle}>
              <span>Show all {total} claim{total === 1 ? "" : "s"}</span>
              <span>Hide claims</span>
            </li>
          </ul>
          <time className={styles.when} dateTime={run.at}>
            {fmtWhen(run.at, timeZone)}
          </time>
        </summary>
        <div className={styles.auction}>
          {run.players.map(({ player, claims }) => (
            <section key={player.id} className={`${styles.lot} ${run.faab ? "" : styles.noBid}`}>
              <h4>
                {fullName(player)} <small>{teamPos(player.teamAbbr, player.position)}</small>
              </h4>
              <ul>
                {claims.map((c) => (
                  <li key={c.team.id} className={c.team.id === myTeamId ? styles.mineClaim : undefined}>
                    <b className={c.won ? styles.plus : styles.minus} aria-label={c.won ? "Won" : "Failed"}>
                      {c.won ? "✓" : "✕"}
                    </b>
                    <span className={styles.claimTeam}>{c.team.abbreviation}</span>
                    {run.faab && <span className={styles.bid}>{bidText(c.bid ?? 0)}</span>}
                    <span className={styles.claimText}>
                      {c.won
                        ? c.drop ? `Won · dropped ${fullName(c.drop)}` : "Won"
                        : `${c.reason ?? "Failed"}${c.drop ? ` (would have dropped ${fullName(c.drop)})` : ""}`}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </details>
    </li>
  );
}

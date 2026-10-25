// The League page's Recent transactions: every completed roster move, newest
// first. Rendered by type, with a generic fallback (each player's from -> to)
// so types added later (trades, waiver claims, commissioner moves) still read.
import Link from "next/link";
import type { FantasyTeamSummary, LeagueTransaction, RecentTransactions as Data, TransactionMove } from "@/lib/types";
import { fullName, teamPos } from "@/components/players/format";
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
    const verb = tx.type === "waiver_claim" ? "Claimed" : "Added";
    return { sign: "+", verb: m.to.id === tx.team?.id ? verb : `${verb} to ${m.to.abbreviation}` };
  }
  return { sign: "→", verb: `${m.from.abbreviation} to ${m.to.abbreviation}` };
}

export default function RecentTransactions({ data, myTeamId }: { data: Data | null; myTeamId: number | null }) {
  if (!data) return null;
  return (
    <section className={styles.card} aria-labelledby="recent-transactions-heading">
      <h3 id="recent-transactions-heading">Recent transactions</h3>
      {data.transactions.length === 0 ? (
        <p className={styles.empty}>No transactions yet. Adds, drops, claims and trades show up here.</p>
      ) : (
        <ol className={styles.list}>
          {data.transactions.map((tx) => (
            <li key={tx.id} className={`${styles.tx} ${tx.team?.id === myTeamId ? styles.mine : ""}`}>
              <div className={styles.who}>
                {tx.team ? (
                  <>
                    <i aria-hidden="true">{tx.team.abbreviation}</i>
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
                {fmtWhen(tx.at, data.timeZone)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

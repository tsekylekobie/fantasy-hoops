// The League page's transaction feed (pure): completed transactions and waiver
// reports, newest first. Claims one of our waiver runs decided arrive already
// grouped (getWaiverRunEntries in queries/league.ts); claims without a run
// (imported from Yahoo, which only tells us who won what and when) are grouped
// here by the minute they went through, so a night's claims read as one report.
import type { LeagueTransaction, TransactionEntry, WaiverRunClaim, WaiverRunEntry } from "../types";

/** Groups completed claims that have no waiver run into one report per minute; the rest pass through. */
export function groupUnrunClaims(txs: LeagueTransaction[]): { transactions: LeagueTransaction[]; reports: WaiverRunEntry[] } {
  const transactions: LeagueTransaction[] = [];
  const byMinute = new Map<string, LeagueTransaction[]>();
  for (const tx of txs) {
    if (tx.type !== "waiver_claim" || tx.team === null) {
      transactions.push(tx);
      continue;
    }
    const minute = tx.at.slice(0, 16); // "YYYY-MM-DDTHH:MM", UTC
    if (!byMinute.has(minute)) byMinute.set(minute, []);
    byMinute.get(minute)!.push(tx);
  }

  const reports = [...byMinute.values()].map((claims): WaiverRunEntry => {
    const players = new Map<number, WaiverRunEntry["players"][number]>();
    for (const tx of claims) {
      const drop = tx.moves.find((m) => m.to === null)?.player ?? null;
      const adds = tx.moves.filter((m) => m.from === null && m.to !== null);
      for (const add of adds) {
        const claim: WaiverRunClaim = { team: tx.team!, bid: tx.faabBid, won: true, drop, reason: null };
        if (!players.has(add.player.id)) players.set(add.player.id, { player: add.player, claims: [] });
        players.get(add.player.id)!.claims.push(claim);
      }
    }
    const list = [...players.values()].sort((a, b) =>
      (b.claims[0].bid ?? -1) - (a.claims[0].bid ?? -1) || a.player.lastName.localeCompare(b.player.lastName));
    return {
      id: null,
      // The latest claim's time, so the report sorts where its claims would have.
      at: claims.reduce((latest, tx) => (tx.at > latest ? tx.at : latest), claims[0].at),
      faab: claims.some((tx) => tx.faabBid !== null),
      won: list.reduce((n, p) => n + p.claims.length, 0),
      failed: 0,
      players: list,
    };
  });
  return { transactions, reports };
}

/** Transactions and waiver reports (ours and grouped claims), newest first. */
export function transactionFeed(txs: LeagueTransaction[], runs: WaiverRunEntry[]): TransactionEntry[] {
  const { transactions, reports } = groupUnrunClaims(txs);
  return [
    ...transactions.map((tx): TransactionEntry => ({ kind: "tx", tx })),
    ...[...runs, ...reports].map((run): TransactionEntry => ({ kind: "run", run })),
  ].sort((a, b) => atOf(b).localeCompare(atOf(a)));
}

const atOf = (e: TransactionEntry) => (e.kind === "tx" ? e.tx.at : e.run.at);

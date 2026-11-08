// The League page's transaction feed (pure): completed transactions and waiver
// reports, newest first. Claims one of our waiver runs decided arrive already
// grouped (getWaiverRunEntries in queries/league.ts); claims without a run
// (imported from Yahoo: who won what and when, and the failed claims when the
// import had them) are grouped here by the minute they were decided, so a night's
// claims read as one report.
import type { LeagueTransaction, PlayerSummary, TransactionEntry, WaiverRunClaim, WaiverRunEntry } from "../types";

type ReportPlayer = WaiverRunEntry["players"][number];

/**
 * Puts a report's claims in order (each player's winner first, then by bid) and its players
 * (won first, then by top bid, then name), and says why each claim lost to the winner, for the
 * whole league: a reason that's missing, or worded for the losing manager ("... went to ABC").
 */
export function finishReport(players: ReportPlayer[], faab: boolean): ReportPlayer[] {
  for (const p of players) {
    p.claims.sort((a, b) => Number(b.won) - Number(a.won) || (b.bid ?? -1) - (a.bid ?? -1) || a.team.name.localeCompare(b.team.name));
    const w = p.claims.find((c) => c.won);
    if (!w) continue;
    const abbr = w.team.abbreviation;
    for (const c of p.claims) {
      if (c.won || (c.reason && !c.reason.includes(` went to ${abbr}`))) continue;
      c.reason = !faab
        ? `${abbr} was ahead in the waiver order.`
        : c.bid === w.bid
          ? `Tied at $${w.bid}; ${abbr} had priority.`
          : `Outbid by ${abbr} at $${w.bid}.`;
    }
  }
  const wonAny = (p: ReportPlayer) => Number(p.claims[0]?.won ?? false);
  return players.sort((a, b) => wonAny(b) - wonAny(a) || (b.claims[0]?.bid ?? -1) - (a.claims[0]?.bid ?? -1)
    || a.player.lastName.localeCompare(b.player.lastName));
}

/** Groups claims that have no waiver run, won or failed, into one report per minute; the rest pass through. */
export function groupUnrunClaims(txs: LeagueTransaction[]): { transactions: LeagueTransaction[]; reports: WaiverRunEntry[] } {
  const transactions: LeagueTransaction[] = [];
  const byMinute = new Map<string, LeagueTransaction[]>();
  for (const tx of txs) {
    if (tx.type !== "waiver_claim" || tx.team === null) {
      // A failed claim is only ever part of a report.
      if (tx.failureReason === null) transactions.push(tx);
      continue;
    }
    const minute = tx.at.slice(0, 16); // "YYYY-MM-DDTHH:MM", UTC
    if (!byMinute.has(minute)) byMinute.set(minute, []);
    byMinute.get(minute)!.push(tx);
  }

  const reports = [...byMinute.values()].map((claims): WaiverRunEntry => {
    const players = new Map<number, ReportPlayer>();
    let won = 0;
    let failed = 0;
    for (const tx of claims) {
      const drop: PlayerSummary | null = tx.moves.find((m) => m.to === null)?.player ?? null;
      const adds = tx.moves.filter((m) => m.from === null && m.to !== null);
      const lost = tx.failureReason !== null;
      for (const add of adds) {
        const claim: WaiverRunClaim = { team: tx.team!, bid: tx.faabBid, won: !lost, drop, reason: lost ? tx.failureReason || null : null };
        if (!players.has(add.player.id)) players.set(add.player.id, { player: add.player, claims: [] });
        players.get(add.player.id)!.claims.push(claim);
        if (lost) failed++;
        else won++;
      }
    }
    const faab = claims.some((tx) => tx.faabBid !== null);
    return {
      id: null,
      // The latest claim's time, so the report sorts where its claims would have.
      at: claims.reduce((latest, tx) => (tx.at > latest ? tx.at : latest), claims[0].at),
      faab,
      won,
      failed,
      players: finishReport([...players.values()], faab),
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

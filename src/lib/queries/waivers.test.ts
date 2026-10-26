// Run: npx tsx --test src/lib/queries/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { faabBidProblem } from "../transactions/policy";
import type { WaiverOrder } from "../types";
import { resolveClaims, type DueClaim, type RunState, type WinEffects } from "./waivers";

// Teams 1-4 (A-D), in that waiver order, $100 each unless a test says otherwise.
function state(type: WaiverOrder["type"], balances: Record<number, number> = {}): RunState {
  const ids = [1, 2, 3, 4];
  return {
    type,
    order: ids,
    balances: new Map(ids.map((id) => [id, balances[id] ?? 100])),
    abbr: new Map(ids.map((id) => [id, "ABCD"[id - 1]])),
  };
}

let nextId = 1;
function claim(teamId: number, player: number, bid: number | null, rank = 1): DueClaim {
  return { id: nextId++, teamId, rank, addPlayerId: player, addName: `P${player}`, dropPlayerId: null, bid };
}

/** Every attempt succeeds unless `fails` names the claim; records the effects passed. */
function attempts(fails: Map<number, string> = new Map()) {
  const calls: { claim: DueClaim; effects: WinEffects }[] = [];
  const attempt = async (c: DueClaim, effects: WinEffects) => {
    calls.push({ claim: c, effects });
    return fails.get(c.id) ?? null;
  };
  return { calls, attempt };
}

const winners = (outcomes: Awaited<ReturnType<typeof resolveClaims>>["outcomes"]) =>
  outcomes.filter((o) => o.won).map((o) => o.claim.id);

test("FAAB: the highest bid wins whatever the waiver order; the winner pays, losers keep their money", async () => {
  const low = claim(1, 10, 5);
  const high = claim(4, 10, 12);
  const { attempt, calls } = attempts();
  const r = await resolveClaims([low, high], state("faab"), attempt);
  assert.deepEqual(winners(r.outcomes), [high.id]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].effects, { order: null, charge: 12 });
  assert.equal(r.balances.get(4), 88);
  assert.equal(r.balances.get(1), 100);
  const lost = r.outcomes.find((o) => o.claim === low)!;
  assert.ok(!lost.won && lost.reason === "P10 went to D, who bid $12.");
  // Not a tie, so nobody's priority moves.
  assert.deepEqual(r.order, [1, 2, 3, 4]);
});

test("FAAB: tied bids go to waiver priority, and the tie winner moves to the back", async () => {
  const c = claim(3, 10, 7);
  const b = claim(2, 10, 7);
  const { attempt, calls } = attempts();
  const r = await resolveClaims([c, b], state("faab"), attempt);
  assert.deepEqual(winners(r.outcomes), [b.id]);
  assert.deepEqual(calls[0].effects, { order: [1, 3, 4, 2], charge: 7 });
  assert.deepEqual(r.order, [1, 3, 4, 2]);
  const won = r.outcomes.find((o) => o.claim === b)!;
  assert.ok(won.won && won.tie);
  const lost = r.outcomes.find((o) => o.claim === c)!;
  assert.ok(!lost.won && /tied \$7 bid/.test(lost.reason));
});

test("FAAB: a team's claims run in bid order across players; later ones are checked against what's left", async () => {
  // Team 1 ranks P20 first, but the bigger bid (P10) goes first, leaving $20.
  const first = claim(1, 20, 30, 1);
  const big = claim(1, 10, 80, 2);
  const r = await resolveClaims([first, big], state("faab"), attempts().attempt);
  assert.deepEqual(winners(r.outcomes), [big.id]);
  const failed = r.outcomes.find((o) => o.claim === first)!;
  assert.ok(!failed.won);
  assert.equal(failed.reason, "Couldn't afford the $30 bid: $20 left after winning earlier claims in this run.");
  assert.equal(r.balances.get(1), 20);
});

test("FAAB: when the high bidder can't afford it, the next bid gets the player", async () => {
  const broke = claim(1, 10, 50);
  const next = claim(2, 10, 10);
  const r = await resolveClaims([broke, next], state("faab", { 1: 40 }), attempts().attempt);
  assert.deepEqual(winners(r.outcomes), [next.id]);
  const failed = r.outcomes.find((o) => o.claim === broke)!;
  assert.ok(!failed.won && failed.reason === "Couldn't afford the $50 bid: $40 left.");
});

test("FAAB: a claim that fails on the roster passes the player to the next bid", async () => {
  const full = claim(1, 10, 20);
  const next = claim(2, 10, 3);
  const { attempt } = attempts(new Map([[full.id, "Your roster is full."]]));
  const r = await resolveClaims([full, next], state("faab"), attempt);
  assert.deepEqual(winners(r.outcomes), [next.id]);
  assert.equal(r.balances.get(1), 100);
  assert.equal(r.balances.get(2), 97);
});

test("FAAB: an equal bid the other team can't pay isn't a tie", async () => {
  const a = claim(1, 10, 30);
  const b = claim(2, 10, 30);
  // Team 1 spends first on a bigger claim, so its $30 for P10 is unaffordable.
  const big = claim(1, 11, 60);
  const r = await resolveClaims([a, b, big], state("faab", { 1: 80 }), attempts().attempt);
  assert.deepEqual(winners(r.outcomes), [big.id, b.id]);
  const won = r.outcomes.find((o) => o.claim === b)!;
  assert.ok(won.won && !won.tie);
  assert.deepEqual(r.order, [1, 2, 3, 4]);
});

test("FAAB: $0 bids are fine, and equal bids from one team go by its own ranking", async () => {
  const second = claim(1, 10, 0, 2);
  const firstRanked = claim(1, 11, 0, 1);
  const { attempt, calls } = attempts();
  const r = await resolveClaims([second, firstRanked], state("faab"), attempt);
  assert.deepEqual(calls.map((c) => c.claim.id), [firstRanked.id, second.id]);
  assert.deepEqual(winners(r.outcomes), [firstRanked.id, second.id]);
  assert.equal(r.balances.get(1), 100);
});

test("FAAB: the manager's own order decides between their equal bids, and can decide which one they can afford", async () => {
  // $25 left: the $15 bid goes first whatever its rank; of the two $10 bids,
  // the one ranked higher gets the last $10 and the other can't be afforded.
  const tenLow = claim(1, 10, 10, 2);
  const tenHigh = claim(1, 11, 10, 1);
  const fifteen = claim(1, 12, 15, 3);
  const { attempt, calls } = attempts();
  const r = await resolveClaims([tenLow, tenHigh, fifteen], state("faab", { 1: 25 }), attempt);
  assert.deepEqual(calls.map((c) => c.claim.id), [fifteen.id, tenHigh.id]);
  assert.deepEqual(winners(r.outcomes), [fifteen.id, tenHigh.id]);
  const failed = r.outcomes.find((o) => o.claim === tenLow)!;
  assert.ok(!failed.won && /\$0 left after winning earlier claims/.test(failed.reason));

  // Swap the ranks and the other $10 claim wins instead.
  const swapped = await resolveClaims(
    [{ ...tenLow, rank: 1 }, { ...tenHigh, rank: 2 }, fifteen], state("faab", { 1: 25 }), attempts().attempt,
  );
  assert.deepEqual(winners(swapped.outcomes), [fifteen.id, tenLow.id]);
});

test("FAAB: equal bids for different players go by waiver priority, without moving anyone", async () => {
  const later = claim(3, 10, 5);
  const earlier = claim(2, 11, 5);
  const { attempt, calls } = attempts();
  const r = await resolveClaims([later, earlier], state("faab"), attempt);
  assert.deepEqual(calls.map((c) => c.claim.id), [earlier.id, later.id]);
  assert.deepEqual(r.order, [1, 2, 3, 4]);
});

test("continual rolling ignores bids: the first team in the order wins and goes to the back", async () => {
  const rich = claim(4, 10, 99);
  const first = claim(2, 10, 0);
  const other = claim(4, 11, null);
  const r = await resolveClaims([rich, first, other], state("continual_rolling"), attempts().attempt);
  assert.deepEqual(winners(r.outcomes), [first.id, other.id]);
  // B wins P10 and goes to the back, then D wins P11 and goes behind it.
  assert.deepEqual(r.order, [1, 3, 2, 4]);
  const lost = r.outcomes.find((o) => o.claim === rich)!;
  assert.ok(!lost.won && lost.reason === "P10 went to B, ahead of you in the waiver order.");
  assert.equal(r.balances.get(2), 100);
});

test("reverse standings: winning doesn't move a team, and a team's claims go by its ranking", async () => {
  const b = claim(1, 11, null, 2);
  const a = claim(1, 10, null, 1);
  const { attempt, calls } = attempts();
  const r = await resolveClaims([b, a], state("reverse_standings"), attempt);
  assert.deepEqual(calls.map((c) => c.claim.id), [a.id, b.id]);
  assert.ok(calls.every((c) => c.effects.order === null && c.effects.charge === 0));
  assert.deepEqual(r.order, [1, 2, 3, 4]);
});

test("faabBidProblem: whole dollars from the minimum up to the balance", () => {
  const faab = { budget: 100, minBid: 0, balance: 40 };
  assert.equal(faabBidProblem(faab, 0), null);
  assert.equal(faabBidProblem(faab, 40), null);
  assert.equal(faabBidProblem(faab, 41), "You only have $40 left to bid.");
  assert.equal(faabBidProblem(faab, 2.5), "Bids are whole dollars.");
  assert.equal(faabBidProblem(faab, "5"), "Bids are whole dollars.");
  assert.equal(faabBidProblem(faab, -1), "Bids can't be negative.");
  assert.equal(faabBidProblem({ ...faab, minBid: 1 }, 0), "The minimum bid is $1.");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { yahooEligible } from "./apply";

test("yahooEligible: Yahoo's positions win over a coarser provider position", () => {
  // ESPN says only "G"; Yahoo lists him at SG and SF.
  assert.deepEqual(yahooEligible(["SG", "SF", "G", "F", "Util"], "G", []), ["SG", "G", "SF", "F", "UTIL", "BN"]);
});

test("yahooEligible: IL slots follow our IL rule, not Yahoo's list", () => {
  assert.deepEqual(yahooEligible(["C", "IL"], "C", []), ["C", "UTIL", "BN"]);
  assert.deepEqual(yahooEligible(["C"], "C", ["IL"]), ["C", "UTIL", "BN", "IL"]);
});

test("yahooEligible: falls back to our position when Yahoo lists none (CSV snapshots)", () => {
  assert.deepEqual(yahooEligible([], "G-F", []), ["PG", "SG", "G", "SF", "PF", "F", "UTIL", "BN"]);
});

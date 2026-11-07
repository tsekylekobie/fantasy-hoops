// Run: npx tsx --test src/lib/auth/members.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalEmail } from "./members";

test("Gmail spellings of one mailbox share a key", () => {
  const key = canonicalEmail("warrenwwang@gmail.com");
  assert.equal(key, "warrenwwang@gmail.com");
  for (const e of ["warren.w.wang@gmail.com", " Warren.W.Wang@Gmail.com ", "warrenwwang+fantasy@gmail.com", "warren.wwang@googlemail.com"]) {
    assert.equal(canonicalEmail(e), key, e);
  }
});

test("other domains keep their dots and tags, only lowercased", () => {
  assert.equal(canonicalEmail(" Nathan.Sam40@Yahoo.com"), "nathan.sam40@yahoo.com");
  assert.equal(canonicalEmail("a.b+c@example.com"), "a.b+c@example.com");
  assert.notEqual(canonicalEmail("a.b@yahoo.com"), canonicalEmail("ab@yahoo.com"));
});

test("not an address: just trimmed and lowercased", () => {
  assert.equal(canonicalEmail(" NoAt "), "noat");
  assert.equal(canonicalEmail("@gmail.com"), "@gmail.com");
});

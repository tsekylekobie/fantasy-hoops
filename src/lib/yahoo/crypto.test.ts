import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { decryptToken, encryptToken, tokenKey } from "./crypto";

test("tokenKey: a base64 32-byte key as is, anything else hashed", () => {
  const raw = randomBytes(32);
  assert.deepEqual(tokenKey(raw.toString("base64")), raw);
  assert.equal(tokenKey("a passphrase that is long enough").length, 32);
  assert.throws(() => tokenKey(""), /YAHOO_TOKEN_KEY/);
  assert.throws(() => tokenKey(undefined), /YAHOO_TOKEN_KEY/);
});

test("encryptToken / decryptToken round trip, fresh IV each time", () => {
  const key = randomBytes(32);
  const a = encryptToken("refresh-token-123", key);
  const b = encryptToken("refresh-token-123", key);
  assert.notEqual(a, b);
  assert.ok(a.startsWith("v1."));
  assert.ok(!a.includes("refresh-token"));
  assert.equal(decryptToken(a, key), "refresh-token-123");
  assert.equal(decryptToken(b, key), "refresh-token-123");
});

test("decryptToken: a wrong key or a tampered token fails", () => {
  const key = randomBytes(32);
  const enc = encryptToken("secret", key);
  assert.throws(() => decryptToken(enc, randomBytes(32)), /YAHOO_TOKEN_KEY changed/);
  const parts = enc.split(".");
  parts[3] = Buffer.from("other").toString("base64url");
  assert.throws(() => decryptToken(parts.join("."), key));
  assert.throws(() => decryptToken("garbage", key), /malformed/);
});

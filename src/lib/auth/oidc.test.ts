// Run: npx tsx --test src/lib/auth/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { profileFromClaims, type IdTokenClaims } from "./oidc";

const NOW = Date.UTC(2026, 10, 5);
const base = (over: Partial<IdTokenClaims> = {}): IdTokenClaims => ({
  iss: "https://api.login.yahoo.com",
  aud: "yahoo-client",
  sub: "ABC123",
  exp: NOW / 1000 + 600,
  email: "manager@yahoo.com",
  email_verified: true,
  name: "Pat Manager",
  picture: "https://s.yimg.com/pic.jpg",
  ...over,
});

test("a Yahoo ID token becomes a verified profile", () => {
  assert.deepEqual(profileFromClaims("yahoo", base(), "yahoo-client", NOW), {
    provider: "yahoo",
    subject: "ABC123",
    email: "manager@yahoo.com",
    emailVerified: true,
    name: "Pat Manager",
    pictureUrl: "https://s.yimg.com/pic.jpg",
  });
});

test("issuer, audience and expiry are checked", () => {
  assert.throws(() => profileFromClaims("yahoo", base({ iss: "https://accounts.google.com" }), "yahoo-client", NOW), /issuer/);
  assert.throws(() => profileFromClaims("google", base(), "yahoo-client", NOW), /issuer/);
  assert.throws(() => profileFromClaims("yahoo", base({ aud: "other" }), "yahoo-client", NOW), /audience/);
  assert.doesNotThrow(() => profileFromClaims("yahoo", base({ aud: ["other", "yahoo-client"] }), "yahoo-client", NOW));
  assert.throws(() => profileFromClaims("yahoo", base({ exp: NOW / 1000 }), "yahoo-client", NOW), /expired/);
});

test("an email is required; it is verified only when the provider says so", () => {
  assert.throws(() => profileFromClaims("yahoo", base({ email: undefined }), "yahoo-client", NOW), /no email/);
  assert.equal(profileFromClaims("yahoo", base({ email_verified: undefined }), "yahoo-client", NOW).emailVerified, false);
  assert.equal(profileFromClaims("yahoo", base({ email_verified: "true" }), "yahoo-client", NOW).emailVerified, true);
  assert.equal(profileFromClaims("yahoo", base({ email_verified: false }), "yahoo-client", NOW).emailVerified, false);
});

test("the name falls back to given + family name, nickname, then email", () => {
  const p = (over: Partial<IdTokenClaims>) => profileFromClaims("yahoo", base({ name: undefined, ...over }), "yahoo-client", NOW);
  assert.equal(p({ given_name: "Pat", family_name: "M" }).name, "Pat M");
  assert.equal(p({ nickname: "patm" }).name, "patm");
  assert.equal(p({}).name, "manager@yahoo.com");
  assert.equal(p({ picture: undefined }).pictureUrl, null);
});

test("Google tokens still check as before", () => {
  const g = profileFromClaims("google", base({ iss: "accounts.google.com", aud: "g" }), "g", NOW);
  assert.equal(g.provider, "google");
});

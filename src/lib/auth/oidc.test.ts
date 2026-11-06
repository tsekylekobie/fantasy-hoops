// Run: npx tsx --test src/lib/auth/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { profileFromClaims, type IdTokenClaims } from "./oidc";

const NOW = Date.UTC(2026, 10, 5);
const CLIENT = "google-client";
const base = (over: Partial<IdTokenClaims> = {}): IdTokenClaims => ({
  iss: "https://accounts.google.com",
  aud: CLIENT,
  sub: "1234567890",
  exp: NOW / 1000 + 600,
  email: "manager@gmail.com",
  email_verified: true,
  name: "Pat Manager",
  picture: "https://lh3.googleusercontent.com/pic.jpg",
  ...over,
});

test("a Google ID token becomes a verified profile", () => {
  assert.deepEqual(profileFromClaims("google", base(), CLIENT, NOW), {
    provider: "google",
    subject: "1234567890",
    email: "manager@gmail.com",
    emailVerified: true,
    name: "Pat Manager",
    pictureUrl: "https://lh3.googleusercontent.com/pic.jpg",
  });
  assert.doesNotThrow(() => profileFromClaims("google", base({ iss: "accounts.google.com" }), CLIENT, NOW));
});

test("issuer, audience and expiry are checked", () => {
  assert.throws(() => profileFromClaims("google", base({ iss: "https://evil.example" }), CLIENT, NOW), /issuer/);
  assert.throws(() => profileFromClaims("google", base({ aud: "other" }), CLIENT, NOW), /audience/);
  assert.doesNotThrow(() => profileFromClaims("google", base({ aud: ["other", CLIENT] }), CLIENT, NOW));
  assert.throws(() => profileFromClaims("google", base({ exp: NOW / 1000 }), CLIENT, NOW), /expired/);
});

test("an email is required; it is verified only when the provider says so", () => {
  assert.throws(() => profileFromClaims("google", base({ email: undefined }), CLIENT, NOW), /no email/);
  assert.equal(profileFromClaims("google", base({ email_verified: undefined }), CLIENT, NOW).emailVerified, false);
  assert.equal(profileFromClaims("google", base({ email_verified: "true" }), CLIENT, NOW).emailVerified, true);
  assert.equal(profileFromClaims("google", base({ email_verified: false }), CLIENT, NOW).emailVerified, false);
});

test("the name falls back to given + family name, nickname, then email", () => {
  const p = (over: Partial<IdTokenClaims>) => profileFromClaims("google", base({ name: undefined, ...over }), CLIENT, NOW);
  assert.equal(p({ given_name: "Pat", family_name: "M" }).name, "Pat M");
  assert.equal(p({ nickname: "patm" }).name, "patm");
  assert.equal(p({}).name, "manager@gmail.com");
  assert.equal(p({ picture: undefined }).pictureUrl, null);
});

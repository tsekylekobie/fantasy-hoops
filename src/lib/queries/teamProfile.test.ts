// Run: npx tsx --test src/lib/queries/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { teamLogoUrl } from "./teamLogo";
import { parseProfileUpdate, sniffImageType } from "./teamProfile";

const error = (body: unknown) => {
  const r = parseProfileUpdate(body);
  return "error" in r ? r.error : null;
};

test("names are trimmed and abbreviations uppercased", () => {
  assert.deepEqual(parseProfileUpdate({ name: "  Fast   Break Fund ", abbreviation: "fbf" }), {
    update: { name: "Fast Break Fund", abbreviation: "FBF" },
  });
  assert.deepEqual(parseProfileUpdate({ teamId: 74, abbreviation: "3PT" }), { update: { teamId: 74, abbreviation: "3PT" } });
});

test("bad names and abbreviations are refused", () => {
  assert.ok(error({ name: " a " }));
  assert.ok(error({ name: "x".repeat(33) }));
  assert.ok(error({ name: 12 }));
  assert.ok(error({ abbreviation: "A" }));
  assert.ok(error({ abbreviation: "ABCDE" }));
  assert.ok(error({ abbreviation: "A-B" }));
  assert.ok(error({ abbreviation: "123" }), "needs a letter");
  assert.ok(error({}), "nothing to change");
  assert.ok(error({ teamId: "74", name: "Okay Name" }));
  assert.ok(error(null));
});

test("image types come from the bytes", () => {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
  const webp = [...Buffer.from("RIFF"), 1, 2, 3, 4, ...Buffer.from("WEBPVP8 ")];
  assert.equal(sniffImageType(Uint8Array.from(png)), "image/png");
  assert.equal(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])), "image/jpeg");
  assert.equal(sniffImageType(Uint8Array.from(webp)), "image/webp");
  assert.equal(sniffImageType(Buffer.from("GIF89a......")), null);
  assert.equal(sniffImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
  assert.equal(sniffImageType(Buffer.from("RIFF1234WAVEfmt ")), null);
  assert.equal(sniffImageType(new Uint8Array()), null);
});

test("logo URLs carry the version", () => {
  assert.equal(teamLogoUrl(73, null), null);
  assert.equal(teamLogoUrl(73, new Date("2026-10-25T12:00:00Z")), `/api/teams/73/logo?v=${Date.parse("2026-10-25T12:00:00Z")}`);
});

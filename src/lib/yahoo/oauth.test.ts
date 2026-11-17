import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCallback, exchangeYahooCode, parseTokenResponse, refreshYahooTokens, yahooAuthorizationUrl, YAHOO_TOKEN_URL } from "./oauth";

test("yahooAuthorizationUrl: code flow with the Fantasy Sports read scope", () => {
  const url = new URL(yahooAuthorizationUrl("st4te", "https://hoops.example/api/yahoo/callback", "cid"));
  assert.equal(url.origin + url.pathname, "https://api.login.yahoo.com/oauth2/request_auth");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "fspt-r");
  assert.equal(url.searchParams.get("state"), "st4te");
  assert.equal(url.searchParams.get("redirect_uri"), "https://hoops.example/api/yahoo/callback");
});

test("checkCallback: state and user must match; a cancel is not an error", () => {
  const saved = { state: "abc", userId: 7 };
  const p = (q: string) => new URLSearchParams(q);
  assert.deepEqual(checkCallback(saved, p("state=abc&code=xyz"), 7), { code: "xyz" });
  assert.ok("error" in checkCallback(saved, p("state=nope&code=xyz"), 7));
  assert.ok("error" in checkCallback(null, p("state=abc&code=xyz"), 7));
  assert.ok("error" in checkCallback(saved, p("state=abc&code=xyz"), 8));
  assert.ok("error" in checkCallback(saved, p("state=abc&code=xyz"), null));
  assert.deepEqual(checkCallback(saved, p("state=abc&error=access_denied"), 7), { cancelled: true });
});

test("parseTokenResponse: tokens, expiry a minute early, guid; errors explained", () => {
  const t = parseTokenResponse({ access_token: "a", refresh_token: "r", expires_in: 3600, token_type: "bearer", xoauth_yahoo_guid: "G" }, 0);
  assert.deepEqual(t, { accessToken: "a", refreshToken: "r", expiresAt: new Date(3_540_000), guid: "G" });
  assert.equal(parseTokenResponse({ access_token: "a" }, 0).refreshToken, null);
  assert.throws(() => parseTokenResponse({ error: "invalid_grant", error_description: "Bad code" }, 0), /Bad code/);
});

test("exchange and refresh: Basic auth, form body, errors surfaced", async () => {
  process.env.YAHOO_CLIENT_ID = "cid";
  process.env.YAHOO_CLIENT_SECRET = "secret";
  const seen: { url: string; init?: RequestInit }[] = [];
  const ok = async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ access_token: "a2", refresh_token: "r2", expires_in: 3600 }), { status: 200 });
  };
  const t = await exchangeYahooCode("the-code", "https://x/cb", ok);
  assert.equal(t.accessToken, "a2");
  assert.equal(seen[0].url, YAHOO_TOKEN_URL);
  const headers = seen[0].init!.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Basic ${Buffer.from("cid:secret").toString("base64")}`);
  const body = new URLSearchParams(seen[0].init!.body as string);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "the-code");
  assert.equal(body.get("redirect_uri"), "https://x/cb");

  await refreshYahooTokens("r1", "https://x/cb", ok);
  const body2 = new URLSearchParams(seen[1].init!.body as string);
  assert.equal(body2.get("grant_type"), "refresh_token");
  assert.equal(body2.get("refresh_token"), "r1");

  const bad = async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token revoked" }), { status: 400 });
  await assert.rejects(refreshYahooTokens("r1", "https://x/cb", bad), /400.*Refresh token revoked/);
});

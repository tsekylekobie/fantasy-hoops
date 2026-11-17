import assert from "node:assert/strict";
import { test } from "node:test";
import { createYahooClient, errorText, isThrottled, YahooApiError, YahooThrottled } from "./api";

const res = (status: number, body: string) => ({ status, text: async () => body }) as unknown as Response;

function setup(answers: { status: number; body: string }[]) {
  const urls: string[] = [];
  const auths: string[] = [];
  const slept: number[] = [];
  const forced: boolean[] = [];
  const client = createYahooClient(async (force) => {
    forced.push(force);
    return force ? "new-token" : "old-token";
  }, {
    fetch: async (url, init) => {
      urls.push(url);
      auths.push((init?.headers as Record<string, string>).Authorization);
      const a = answers.shift();
      if (!a) throw new Error("no more answers");
      return res(a.status, a.body);
    },
    minIntervalMs: 0,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  return { client, urls, auths, slept, forced };
}

test("isThrottled and errorText", () => {
  assert.ok(isThrottled(999, ""));
  assert.ok(isThrottled(429, ""));
  assert.ok(isThrottled(200, "Request denied"));
  assert.ok(!isThrottled(200, '{"fantasy_content":{}}'));
  assert.equal(errorText('{"error":{"description":"Invalid league key"}}'), "Invalid league key");
  assert.equal(errorText("<error><description>Nope</description></error>"), "Nope");
});

test("get: JSON from /fantasy/v2 with format=json and the bearer token", async () => {
  const s = setup([{ status: 200, body: '{"fantasy_content":{"ok":1}}' }]);
  assert.deepEqual(await s.client.get("league/466.l.1/settings"), { fantasy_content: { ok: 1 } });
  assert.equal(s.urls[0], "https://fantasysports.yahooapis.com/fantasy/v2/league/466.l.1/settings?format=json");
  assert.equal(s.auths[0], "Bearer old-token");
  assert.equal(s.client.requestCount, 1);
});

test("get: a 401 refreshes the token once and retries", async () => {
  const s = setup([{ status: 401, body: "" }, { status: 200, body: "{}" }]);
  await s.client.get("x");
  assert.deepEqual(s.forced, [false, true]);
  assert.equal(s.auths[1], "Bearer new-token");
});

test("get: throttled -> waits and retries; still throttled -> YahooThrottled", async () => {
  const ok = setup([{ status: 999, body: "Request denied" }, { status: 200, body: "{}" }]);
  await ok.client.get("x");
  assert.deepEqual(ok.slept, [2000]);
  const no = setup([{ status: 999, body: "" }, { status: 429, body: "" }, { status: 200, body: "Request denied" }]);
  await assert.rejects(no.client.get("x"), YahooThrottled);
  assert.deepEqual(no.slept, [2000, 10000]);
});

test("get: other errors are YahooApiError with Yahoo's reason", async () => {
  const s = setup([{ status: 400, body: '{"error":{"description":"league key 1 does not exist"}}' }]);
  await assert.rejects(s.client.get("league/1/settings"), (e: unknown) => e instanceof YahooApiError && e.status === 400 && /does not exist/.test(e.message));
});

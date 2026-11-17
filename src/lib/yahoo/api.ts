// The Yahoo Fantasy Sports API client: GETs under
// https://fantasysports.yahooapis.com/fantasy/v2 as JSON, with the stored
// connection's access token (refreshed on 401), a small gap between calls, and
// backoff when Yahoo throttles. Yahoo doesn't publish its limits; when it's had
// enough it answers 999 "Request denied" (or 429). We retry a couple of times,
// then give up with YahooThrottled so the sync backs off to a slower interval.
import type { FetchFn } from "./oauth";

export const YAHOO_API_BASE = "https://fantasysports.yahooapis.com/fantasy/v2";

export class YahooThrottled extends Error {
  constructor(message = "Yahoo is throttling requests (Request denied)") {
    super(message);
    this.name = "YahooThrottled";
  }
}

export class YahooApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "YahooApiError";
  }
}

export interface YahooClient {
  /** A resource path under /fantasy/v2, e.g. "league/466.l.12345/settings". */
  get(path: string): Promise<unknown>;
  readonly requestCount: number;
}

export interface ClientOptions {
  fetch?: FetchFn;
  /** Milliseconds between requests (default 300). */
  minIntervalMs?: number;
  /** Waits before each throttled retry (default 2 s, then 10 s). */
  throttleWaitsMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

/** Yahoo's "slow down" answers. */
export function isThrottled(status: number, body: string): boolean {
  return status === 999 || status === 429 || /request denied/i.test(body.slice(0, 500));
}

/** A readable reason from Yahoo's error body ({"error": {"description": ...}}, or XML). */
export function errorText(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { description?: string } | string };
    if (typeof j.error === "string") return j.error;
    if (j.error?.description) return j.error.description;
  } catch {
    // Not JSON.
  }
  const m = /<description>([^<]*)<\/description>/.exec(body);
  return (m?.[1] ?? body).trim().slice(0, 200);
}

/** `token(force)` gives an access token; force = the last one was refused (401). */
export function createYahooClient(token: (force: boolean) => Promise<string>, opts: ClientOptions = {}): YahooClient {
  const fetchFn = opts.fetch ?? fetch;
  const gap = opts.minIntervalMs ?? 300;
  const waits = opts.throttleWaitsMs ?? [2_000, 10_000];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = 0;
  let count = 0;

  async function once(url: string, force: boolean): Promise<{ status: number; body: string }> {
    const wait = last + gap - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    count++;
    const res = await fetchFn(url, { headers: { Authorization: `Bearer ${await token(force)}`, Accept: "application/json" } });
    return { status: res.status, body: await res.text() };
  }

  return {
    get requestCount() {
      return count;
    },
    async get(path: string): Promise<unknown> {
      const url = `${YAHOO_API_BASE}/${path.replace(/^\/+/, "")}${path.includes("?") ? "&" : "?"}format=json`;
      let r = await once(url, false);
      if (r.status === 401) r = await once(url, true);
      for (const w of waits) {
        if (!isThrottled(r.status, r.body) && r.status < 500) break;
        await sleep(w);
        r = await once(url, false);
      }
      if (isThrottled(r.status, r.body)) throw new YahooThrottled();
      if (r.status < 200 || r.status >= 300) throw new YahooApiError(`Yahoo ${path}: ${r.status} ${errorText(r.body)}`, r.status);
      try {
        return JSON.parse(r.body);
      } catch {
        throw new YahooApiError(`Yahoo ${path}: not JSON (${r.body.slice(0, 80)})`, r.status);
      }
    },
  };
}

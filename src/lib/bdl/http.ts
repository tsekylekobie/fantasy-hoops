// Low-level HTTP for BALLDONTLIE: auth header, rate limiting, retries and
// cursor pagination. Config comes from env (BALLDONTLIE_API_KEY,
// BALLDONTLIE_BASE_URL, BALLDONTLIE_RPM).

import type { BdlPage } from "./raw";

export type QueryValue = string | number | boolean | Array<string | number> | null | undefined;
export type Query = Record<string, QueryValue>;

export class BdlError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "BdlError";
  }
}

const DEFAULT_BASE_URL = "https://api.balldontlie.io/v1";
const MAX_RETRIES = 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Serializes requests and spaces them evenly so we stay under the RPM.
 * A 5% safety margin is applied, e.g. 60 RPM -> one request every 1050 ms.
 */
class RateLimiter {
  private nextAt = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly intervalMs: number) {}

  acquire(): Promise<void> {
    const turn = this.chain.then(async () => {
      const wait = this.nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextAt = Date.now() + this.intervalMs;
    });
    this.chain = turn.catch(() => undefined);
    return turn;
  }

  /** Push the next slot back, e.g. after a 429. */
  backoff(ms: number) {
    this.nextAt = Math.max(this.nextAt, Date.now() + ms);
  }
}

export interface BdlHttpOptions {
  apiKey?: string;
  baseUrl?: string;
  rpm?: number;
  /** Optional hook for logging each request. */
  onRequest?: (url: string, attempt: number) => void;
}

export class BdlHttp {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly limiter: RateLimiter;
  private readonly onRequest?: (url: string, attempt: number) => void;
  /** Total HTTP requests sent (including retries). */
  requestCount = 0;

  constructor(opts: BdlHttpOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.BALLDONTLIE_API_KEY;
    if (!apiKey) throw new Error("BALLDONTLIE_API_KEY is not set");
    this.apiKey = apiKey;
    this.baseUrl = (opts.baseUrl ?? process.env.BALLDONTLIE_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    const rpm = opts.rpm ?? Number(process.env.BALLDONTLIE_RPM ?? 60);
    if (!Number.isFinite(rpm) || rpm <= 0) throw new Error(`Invalid BALLDONTLIE_RPM: ${rpm}`);
    this.limiter = new RateLimiter(Math.ceil((60_000 / rpm) * 1.05));
    this.onRequest = opts.onRequest;
  }

  buildUrl(path: string, query: Query = {}): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        // Array params use the `name[]=` convention (seasons[], dates[], ...).
        const name = key.endsWith("[]") ? key : `${key}[]`;
        for (const v of value) params.append(name, String(v));
      } else {
        params.append(key, String(value));
      }
    }
    const qs = params.toString();
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}${qs ? `?${qs}` : ""}`;
  }

  /** GET a JSON resource with rate limiting and retries on 429/5xx/network errors. */
  async get<T>(path: string, query: Query = {}): Promise<T> {
    const url = this.buildUrl(path, query);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.limiter.acquire();
      this.requestCount++;
      this.onRequest?.(url, attempt);
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { Authorization: this.apiKey, Accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        lastErr = err;
        await sleep(backoffMs(attempt));
        continue;
      }
      if (res.ok) return (await res.json()) as T;

      const body = await res.text().catch(() => "");
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);
        // On 429 the whole client should slow down, not just this request.
        if (res.status === 429) this.limiter.backoff(wait);
        lastErr = new BdlError(`BALLDONTLIE ${res.status}: ${body.slice(0, 200)}`, res.status, url);
        await sleep(wait);
        continue;
      }
      throw new BdlError(`BALLDONTLIE ${res.status}: ${body.slice(0, 200)}`, res.status, url);
    }
    throw lastErr instanceof Error ? lastErr : new Error(`BALLDONTLIE request failed: ${url}`);
  }

  /** GET one page of a cursor-paginated list. */
  async page<T>(path: string, query: Query = {}): Promise<{ data: T[]; nextCursor: number | null }> {
    const body = await this.get<BdlPage<T>>(path, query);
    return { data: body.data, nextCursor: body.meta?.next_cursor ?? null };
  }

  /** Iterate pages of a cursor-paginated list, starting at `query.cursor` if given. */
  async *pages<T>(
    path: string,
    query: Query = {},
  ): AsyncGenerator<{ data: T[]; cursor: number | null; nextCursor: number | null }> {
    let cursor = (query.cursor as number | undefined) ?? null;
    for (;;) {
      const { data, nextCursor } = await this.page<T>(path, { ...query, cursor });
      yield { data, cursor, nextCursor };
      if (nextCursor == null) return;
      cursor = nextCursor;
    }
  }
}

function backoffMs(attempt: number): number {
  // 2s, 4s, 8s, ... capped at 60s, plus jitter.
  return Math.min(60_000, 2_000 * 2 ** attempt) + Math.floor(Math.random() * 500);
}

// Low-level HTTP for ESPN's keyless JSON endpoints: one request at a time,
// paced (ESPN_RPS, default 1 per second), retried with backoff on 429, 5xx and
// network errors. ESPN publishes no limits; the pacing is just to be polite.

export class EspnError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "EspnError";
  }
}

export const ESPN_BASE_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const MAX_RETRIES = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoffMs(attempt: number): number {
  // 2s, 4s, 8s, ... capped at 60s, plus jitter.
  return Math.min(60_000, 2_000 * 2 ** attempt) + Math.floor(Math.random() * 500);
}

export interface EspnHttpOptions {
  baseUrl?: string;
  /** Requests per second. */
  rps?: number;
  onRequest?: (url: string, attempt: number) => void;
}

export class EspnHttp {
  private readonly baseUrl: string;
  private readonly intervalMs: number;
  private readonly onRequest?: (url: string, attempt: number) => void;
  private nextAt = 0;
  private chain: Promise<void> = Promise.resolve();
  /** Total HTTP requests sent (including retries). */
  requestCount = 0;

  constructor(opts: EspnHttpOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.ESPN_BASE_URL ?? ESPN_BASE_URL).replace(/\/+$/, "");
    const rps = opts.rps ?? Number(process.env.ESPN_RPS ?? 1);
    if (!Number.isFinite(rps) || rps <= 0) throw new Error(`Invalid ESPN_RPS: ${rps}`);
    this.intervalMs = Math.ceil(1000 / rps);
    this.onRequest = opts.onRequest;
  }

  /** Waits for this request's turn; requests are serialized and spaced intervalMs apart. */
  private acquire(): Promise<void> {
    const turn = this.chain.then(async () => {
      const wait = this.nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextAt = Date.now() + this.intervalMs;
    });
    this.chain = turn.catch(() => undefined);
    return turn;
  }

  url(path: string, query: Record<string, string | number | undefined> = {}): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params.append(k, String(v));
    const qs = params.toString();
    return `${this.baseUrl}/${path.replace(/^\/+/, "")}${qs ? `?${qs}` : ""}`;
  }

  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = this.url(path, query);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.acquire();
      this.requestCount++;
      this.onRequest?.(url, attempt);
      let res: Response;
      try {
        res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      } catch (err) {
        lastErr = err;
        await sleep(backoffMs(attempt));
        continue;
      }
      if (res.ok) return (await res.json()) as T;
      const body = await res.text().catch(() => "");
      const err = new EspnError(`ESPN ${res.status}: ${body.slice(0, 200)}`, res.status, url);
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);
        // Slow every request down, not just this one.
        this.nextAt = Math.max(this.nextAt, Date.now() + wait);
        lastErr = err;
        await sleep(wait);
        continue;
      }
      throw err;
    }
    throw lastErr instanceof Error ? lastErr : new Error(`ESPN request failed: ${url}`);
  }
}

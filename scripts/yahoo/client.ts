// Yahoo Fantasy Sports API access for the Yahoo import (export.ts).
//
// OAuth 2.0 with a Yahoo app you register at https://developer.yahoo.com/apps/
// (API permissions: Fantasy Sports, Read). YAHOO_CLIENT_ID and
// YAHOO_CLIENT_SECRET come from .env. The first run prints a sign-in URL;
// approve it and paste back the code Yahoo shows (redirect URI "oob"), or the
// whole address you were redirected to (any other YAHOO_REDIRECT_URI). Tokens
// are kept in .yahoo-tokens.json (gitignored) and refreshed as needed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const AUTH_URL = "https://api.login.yahoo.com/oauth2/request_auth";
const TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
const API = "https://fantasysports.yahooapis.com/fantasy/v2";
const TOKEN_FILE = ".yahoo-tokens.json";

interface Tokens {
  access_token: string;
  refresh_token: string;
  /** ms since epoch. */
  expires_at: number;
}

function credentials() {
  const id = process.env.YAHOO_CLIENT_ID;
  const secret = process.env.YAHOO_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Set YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET in .env (see .env.example).");
  return { id, secret, redirect: process.env.YAHOO_REDIRECT_URI || "oob" };
}

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const { id, secret } = credentials();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`Yahoo token request failed (${res.status}): ${await res.text()}`);
  const t = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  const tokens = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in - 60) * 1000 };
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  return tokens;
}

async function signIn(): Promise<Tokens> {
  const { id, redirect } = credentials();
  const url = `${AUTH_URL}?${new URLSearchParams({ client_id: id, redirect_uri: redirect, response_type: "code" })}`;
  console.log(`Sign in to Yahoo and approve access:\n\n  ${url}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Paste the code (or the address you were sent to): ")).trim();
  rl.close();
  const code = /^https?:/.test(answer) ? new URL(answer).searchParams.get("code") ?? "" : answer;
  if (!code) throw new Error("No code given.");
  return tokenRequest({ grant_type: "authorization_code", redirect_uri: redirect, code });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class YahooClient {
  private constructor(private tokens: Tokens) {}

  /** Saved tokens, or an interactive sign-in. */
  static async connect(): Promise<YahooClient> {
    const saved = existsSync(TOKEN_FILE) ? (JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as Tokens) : null;
    return new YahooClient(saved ?? (await signIn()));
  }

  private async refresh() {
    const { redirect } = credentials();
    this.tokens = await tokenRequest({ grant_type: "refresh_token", redirect_uri: redirect, refresh_token: this.tokens.refresh_token });
  }

  /** GET a fantasy/v2 path ("league/466.l.123/settings") as JSON. Retries when rate limited. */
  async get(path: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      if (Date.now() >= this.tokens.expires_at) await this.refresh();
      const res = await fetch(`${API}/${path}${path.includes("?") ? "&" : "?"}format=json`, {
        headers: { Authorization: `Bearer ${this.tokens.access_token}` },
      });
      if (res.ok) return res.json();
      if (res.status === 401 && attempt === 0) {
        await this.refresh();
        continue;
      }
      // Yahoo answers 999 (or 429) when it wants you to slow down.
      if ((res.status === 999 || res.status === 429 || res.status >= 500) && attempt < 5) {
        const wait = 15_000 * (attempt + 1);
        console.warn(`  Yahoo ${res.status} on ${path}; retrying in ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      throw new Error(`Yahoo ${res.status} for ${path}: ${(await res.text()).slice(0, 300)}`);
    }
  }
}

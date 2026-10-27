// Player news from ESPN's public (undocumented, keyless) fantasy endpoints.
// Fetched on demand and cached in memory; nothing is stored. The blurbs are
// Rotowire's, the same ones ESPN shows in its fantasy app.

import { normalizeName } from "@/lib/queries/params";
import type { PlayerNewsItem } from "@/lib/types";

const SEARCH_URL = "https://site.web.api.espn.com/apis/common/v3/search";
const NEWS_URL = "https://site.api.espn.com/apis/fantasy/v2/games/fba/news/players";
const TIMEOUT_MS = 5000;
const NEWS_TTL_MS = 5 * 60_000;
const MISS_TTL_MS = 60 * 60_000;
const MAX_ITEMS = 8;

interface SearchResponse {
  items?: { id?: string; displayName?: string; league?: string }[];
}

interface NewsResponse {
  feed?: { id?: number; type?: string; headline?: string; story?: string; published?: string }[];
}

// ESPN ids never change, so a hit is kept for the life of the process; a miss is retried after an hour.
const espnIds = new Map<string, { id: number | null; at: number }>();
const news = new Map<number, { items: PlayerNewsItem[]; at: number }>();

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  if (!res.ok) throw new Error(`ESPN ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/** "Jaren Jackson Jr." and "Jaren Jackson" compare equal. */
function nameKey(name: string): string {
  return normalizeName(name).replace(/ (jr|sr|ii|iii|iv|v)$/, "");
}

/** The NBA player ESPN knows by exactly this name, or null (none, or more than one). */
async function findEspnId(fullName: string): Promise<number | null> {
  const key = nameKey(fullName);
  const cached = espnIds.get(key);
  if (cached && (cached.id !== null || Date.now() - cached.at < MISS_TTL_MS)) return cached.id;

  const q = new URLSearchParams({ query: fullName, type: "player", limit: "10" });
  const body = await getJson<SearchResponse>(`${SEARCH_URL}?${q}`);
  const matches = (body.items ?? []).filter(
    (i) => i.league === "nba" && i.id && i.displayName && nameKey(i.displayName) === key,
  );
  const id = matches.length === 1 ? Number(matches[0].id) : null;
  espnIds.set(key, { id, at: Date.now() });
  return id;
}

/** The player's latest fantasy news, newest first; [] when ESPN has no match for his name. */
export async function getPlayerNews(fullName: string): Promise<PlayerNewsItem[]> {
  const espnId = await findEspnId(fullName);
  if (espnId === null) return [];
  const cached = news.get(espnId);
  if (cached && Date.now() - cached.at < NEWS_TTL_MS) return cached.items;

  const q = new URLSearchParams({ playerId: String(espnId), limit: "20" });
  const body = await getJson<NewsResponse>(`${NEWS_URL}?${q}`);
  // Only the written updates; the feed also carries highlight videos.
  const items = (body.feed ?? [])
    .filter((f) => f.type === "Rotowire" && f.headline && f.published)
    .slice(0, MAX_ITEMS)
    .map((f) => ({ id: String(f.id), headline: f.headline!, story: f.story || null, published: f.published! }));
  news.set(espnId, { items, at: Date.now() });
  return items;
}

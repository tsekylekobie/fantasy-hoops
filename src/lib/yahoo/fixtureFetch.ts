// A stand-in for Yahoo, serving fixtures/*.json: the token endpoint and every
// call sync.ts makes, for `npm run yahoo:sync -- --fixtures` (a dev database
// mirrored from the made-up league 466.l.12345 without a Yahoo key) and tests.
// Rosters are answered for whatever date is asked; scoreboards without a
// fixture have no matchups.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchFn } from "./oauth";

const DIR = join(__dirname, "fixtures");
const file = (name: string) => readFileSync(join(DIR, `${name}.json`), "utf8");
const has = (name: string) => {
  try {
    file(name);
    return true;
  } catch {
    return false;
  }
};

export interface FixtureFetch {
  fetch: FetchFn;
  /** Every URL asked for, in order. */
  calls: string[];
}

/** `answer` can override a path's response (status + body), e.g. to simulate throttling. */
export function fixtureFetch(answer?: (path: string) => { status: number; body: string } | null): FixtureFetch {
  const calls: string[] = [];
  const json = (body: string, status = 200) => new Response(body, { status, headers: { "Content-Type": "application/json" } });
  const fetchFn: FetchFn = async (input) => {
    const url = new URL(input);
    calls.push(url.pathname + url.search);
    if (url.hostname === "api.login.yahoo.com") {
      return json(JSON.stringify({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600, token_type: "bearer", xoauth_yahoo_guid: "GUID1" }));
    }
    const path = decodeURIComponent(url.pathname.replace(/^\/fantasy\/v2\//, ""));
    const override = answer?.(path);
    if (override) return json(override.body, override.status);
    let m: RegExpExecArray | null;
    if (path.startsWith("users;use_login=1")) return json(file("user_leagues"));
    if ((m = /^league\/[^/]+\/(settings|teams|standings)$/.exec(path))) return json(file(m[1]));
    if (/^game\/[^/]+\/game_weeks$/.test(path)) return json(file("game_weeks"));
    if ((m = /^league\/[^/]+\/scoreboard;week=(\d+)$/.exec(path))) {
      if (has(`scoreboard_week${m[1]}`)) return json(file(`scoreboard_week${m[1]}`));
      const settings = JSON.parse(file("settings"));
      return json(JSON.stringify({ fantasy_content: { league: [settings.fantasy_content.league[0], { scoreboard: { "0": { matchups: { count: 0 } }, week: m[1] } }] } }));
    }
    if ((m = /^team\/[^/]+\.t\.(\d+)\/roster;date=(\d{4}-\d{2}-\d{2})$/.exec(path))) {
      const [, team, date] = m;
      const name = has(`roster_team${team}_${date}`) ? `roster_team${team}_${date}` : `roster_team${team}`;
      return json(file(name).replaceAll(/"date": "\d{4}-\d{2}-\d{2}"/g, `"date": "${date}"`));
    }
    if ((m = /^league\/[^/]+\/transactions(;.*)?$/.exec(path))) {
      const start = Number(/;start=(\d+)/.exec(m[1] ?? "")?.[1] ?? 0);
      if (start === 0) return json(file("transactions"));
      const settings = JSON.parse(file("settings"));
      return json(JSON.stringify({ fantasy_content: { league: [settings.fantasy_content.league[0], { transactions: { count: 0 } }] } }));
    }
    return json(JSON.stringify({ error: { description: `No fixture for ${path}` } }), 404);
  };
  return { fetch: fetchFn, calls };
}

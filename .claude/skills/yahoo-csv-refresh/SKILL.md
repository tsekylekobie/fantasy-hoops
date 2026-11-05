---
name: yahoo-csv-refresh
description: Build or refresh a Yahoo fantasy basketball league's CSV snapshot from its Yahoo pages in Chrome, then dry-run and import it with `npm run yahoo:import`. Use when asked to refresh the Yahoo CSVs, re-export or re-import a Yahoo league, or move a league over while Yahoo's Fantasy API answers 403.
argument-hint: <yahoo-league-id>
---

# Yahoo CSV snapshot

League id: `$ARGUMENTS`. If that's blank, ask for it (it's in the league's Yahoo URL, `/nba/<league-id>`). Below,
`<id>` is that id and `<folder>` is `yahoo-export/<id>-csv`.

Use this while Yahoo's Fantasy API answers 403 (README, "Without Yahoo's API: from CSVs"). File formats are there and
in `src/lib/yahoo/csv.ts`.

## Ground rules

- **Yahoo is read-only.** Only read pages. Don't click anything that changes the league.
- **One sitting.** The import refuses a snapshot whose `today` isn't today in the league's time zone, so finish on the
  day you start.
- **Dry run first.** Never pass `--apply` before a clean dry run and the user's go-ahead.
- **`--replace` deletes the season's whole league**, including everything done in the app since the last import. Use
  it only when the user says so for this run. Users and sign-ins are kept.
- **Back up first.** Before changing an existing folder, copy it to `<folder>.bak-<date in its league.json>`.
- **Keep it private.** `yahoo-export/` is gitignored and holds manager emails. Never commit it or quote emails back.
- **Main checkout.** `yahoo-export/` exists only in the main checkout, the parent of `git rev-parse --git-common-dir`.
  Worktrees don't have it. Pass the snapshot's absolute path if you run the import from a worktree.

## Reading Yahoo

Use Claude in Chrome (load the `anthropic-skills:chrome-browser` skill first) with Chrome signed in to Yahoo, or have
the user paste the scripts into the DevTools console, where `copy(...)` puts the result on the clipboard. Each script
runs on any page under `basketball.fantasysports.yahoo.com` and only fetches with the user's sign-in.

- `javascript_tool` cuts output at about 1,000 characters. Store results on `window`, then read
  `.join("\n").slice(0, 950)`, `.slice(950, 1900)` and so on, several to a `browser_batch`. Compare the line count
  with the script's summary at the end.
- If output comes back `[BLOCKED: Cookie/query string data]`, Chrome's filter is protecting cookies and URLs. Return
  only data rows, never hrefs or `document.cookie`. Don't re-encode or disguise output to get past the block. If plain
  rows are still blocked, ask the user to run the script in DevTools.
- Close the tabs you opened when you're done.

## Refresh or first build

If `<folder>/league.json` exists, this is a refresh:

| File | On a refresh |
|---|---|
| `league.json` | Set `today` |
| `teams.csv` | Update `waiver_priority` and `faab_balance`: step 2 |
| `results.csv` | Add weeks finished since last time: step 4 |
| `rosters.csv`, `lineups.csv` | Rebuild: step 5 |
| `schedule.csv`, `league-settings.json`, `player-overrides.csv` | Keep. The import adds to `player-overrides.csv` |

Otherwise it's a first build: do every step, in order.

## 1. League settings (first build)

Read `https://basketball.fantasysports.yahoo.com/nba/<id>/settings` with `get_page_text`.

Write `<folder>/league.json`. `season` is the year the season starts (`2026` means 2026-27).

```json
{
  "name": "<League Name>",
  "season": 2026,
  "today": "yyyy-mm-dd",
  "rosterSlots": { "G": 3, "F": 3, "C": 1, "Util": 3, "BN": 4, "IL": 2 },
  "playoffStartWeek": 18,
  "settings": {
    "waiverType": "faab",
    "waiverDays": 2,
    "tradeReview": "commissioner",
    "tradeReviewDays": 1,
    "tradeDeadline": "yyyy-mm-dd",
    "maxAddsPerWeek": 4,
    "maxAddsPerSeason": null,
    "playoffTeams": 8
  }
}
```

The values above are examples. Take each one from the page:

| Field | Yahoo setting |
|---|---|
| `rosterSlots` | Count each position in Roster Positions |
| `playoffStartWeek`, `playoffTeams` | Playoffs |
| `waiverType` | Waiver Type: FAB is `faab`, otherwise `continual_rolling` or `reverse_standings` |
| `waiverDays` | Waiver Time |
| `tradeReview` | Trade Review: `commissioner`, `league_vote` or `none` |
| `tradeReviewDays` | Trade Reject Time |
| `tradeDeadline` | Trade End Date |
| `maxAddsPerWeek`, `maxAddsPerSeason` | Max Acquisitions per Week, for Entire Season. "No maximum" is `null` |

Write `<folder>/league-settings.json` for settings Yahoo's page doesn't give. `waiverDaysOfWeek` comes from Waiver
Processing Days, as ISO weekdays (Monday is 1, Sunday is 7). Ask the user for `timeZone`, and for `faabBudget` if it
isn't obvious from the Managers page. Any other field of `LeagueSettings` in `src/lib/types.ts` can go here too.

```json
{ "faabBudget": 100, "waiverDaysOfWeek": [1, 2, 3, 4, 5, 6, 7], "timeZone": "America/New_York" }
```

Today's date for everything below is in that `timeZone`. On a refresh, read it from `league-settings.json`.

## 2. Teams, waivers and FAAB

Open `https://basketball.fantasysports.yahoo.com/nba/<id>/teams` (Yahoo's Managers page) and run:

```js
const rows = [...document.querySelectorAll("table tbody tr")].map((r) => {
  const c = [...r.querySelectorAll("td")].map((td) => td.textContent.trim());
  const link = [...r.querySelectorAll("a")].map((a) => (a.getAttribute("href") || "").match(/\/(\d+)$/)).find(Boolean);
  // team, name, abbreviation, email, commissioner, waiver_priority, faab_balance
  return c[1] ? [link ? link[1] : "", `"${c[0]}"`, "", c[2], /Commissioner$/.test(c[1]) ? "yes" : "", c[4], c[3].replace("$", "")] : null;
}).filter(Boolean).sort((a, b) => a[0] - b[0]);
window.__teams = rows.map((r) => r.join(","));
JSON.stringify({ teams: rows.length, noId: rows.filter((r) => !r[0]).length });
```

The `teams` count is the league's number of teams, used below. `noId` should be 0.

- **First build:** write the rows to `teams.csv` under the header
  `team,name,abbreviation,email,commissioner,waiver_priority,faab_balance`. `team` is Yahoo's team number. Leave
  `abbreviation` blank unless the user has some.
- **Refresh:** update only `waiver_priority` and `faab_balance`, matching on `team`, and report what changed. Keep the
  emails already in the file, since the user may have edited them.

Sign-in links a manager to a team by email through Google, so flag any manager without a Google-capable address.

## 3. Schedule (first build)

Set `weeks` to the last week of the season (from the Playoffs setting) and run:

```js
const league = 0, weeks = 0, season = 0; // <id>, last week, league.json's season
const iso = (m, d) => `${+m >= 7 ? season : season + 1}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
const rows = [];
for (let w = 1; w <= weeks; w++) {
  const h = await (await fetch(`/nba/${league}?matchup_week=${w}&module=matchups`, { credentials: "include" })).text();
  const pairs = [...new Set([...h.matchAll(/matchup\?week=(\d+)&(?:amp;)?mid1=(\d+)&(?:amp;)?mid2=(\d+)/g)]
    .filter((m) => m[1] === String(w))
    .map((m) => [+m[2], +m[3]].sort((a, b) => a - b).join(",")))];
  const q = pairs[0] ? `mid1=${pairs[0].split(",")[0]}&mid2=${pairs[0].split(",")[1]}` : "mid1=1";
  const doc = new DOMParser().parseFromString(await (await fetch(`/nba/${league}/matchup?week=${w}&${q}`, { credentials: "include" })).text(), "text/html");
  const days = [...doc.body.textContent.matchAll(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\/(\d{1,2})/g)].map((m) => iso(m[1], m[2]));
  const start = days[0] || "", end = days[days.length - 1] || "";
  if (pairs.length === 0) rows.push(`${w},${start},${end},,`); // playoffs: dates, no pairings yet
  for (const p of pairs) rows.push(`${w},${start},${end},${p}`);
}
window.__schedule = rows;
JSON.stringify({ rows: rows.length, weeks: new Set(rows.map((r) => r.split(",")[0])).size, noDates: rows.filter((r) => r.split(",")[1] === "").length });
```

Save the rows to `schedule.csv` under the header `week,start,end,team_a,team_b`. `weeks` should equal the last week and
`noDates` should be 0. Each regular-season week should have half the teams' count of rows.

Don't assume weeks run Monday to Sunday. The first is often short and some span two weeks (the All-Star break, for
example), so always take dates from `schedule.csv`.

## 4. Results of finished weeks

A week is finished once its `end` is before today. First build: every finished week. Refresh: those not yet in
`results.csv`. Skip this step if there are none.

Fill `games` from `schedule.csv` and run:

```js
const league = 0; // <id>
const games = [[1, 1, 6], [1, 2, 8]]; // [week, team_a, team_b] for every matchup to read
const out = [];
for (const [week, a, b] of games) {
  const html = await (await fetch(`/nba/${league}/matchup?week=${week}&mid1=${a}&mid2=${b}`, { credentials: "include" })).text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const lines = [...doc.querySelectorAll("table tr")]
    .map((r) => [...r.querySelectorAll("td,th")].map((c) => c.textContent.trim()))
    .filter((c) => c.length >= 12 && /^\d+\/\d+$/.test(c[1] || ""));
  lines.slice(0, 2).forEach((c, i) => {
    const [fgm, fga] = c[1].split("/"), [ftm, fta] = c[3].split("/");
    out.push([week, i ? b : a, fgm, fga, ftm, fta, ...c.slice(5, 12)].join(","));
  });
}
window.__results = out;
JSON.stringify({ rows: out.length, expected: games.length * 2 });
```

Add the rows to `results.csv` under the header `week,team,fgm,fga,ftm,fta,fg3m,pts,reb,ast,stl,blk,tov`. The script
assumes the league's nine categories (FG%, FT%, 3PTM, PTS, REB, AST, ST, BLK, TO, in Yahoo's order). Check one matchup's
category score against Yahoo's page to confirm the columns still line up and the first line really is `team_a`.

## 5. Rosters and lineups

Find the week whose `start`–`end` contains today in `schedule.csv`. Set `start` to that week's first day, `today` to
today and `teams` to the count from step 2, then run:

```js
const league = 0, teams = 0, start = "yyyy-mm-dd", today = "yyyy-mm-dd";
const dates = [];
for (let d = new Date(`${start}T12:00:00Z`); d.toISOString().slice(0, 10) <= today; d.setUTCDate(d.getUTCDate() + 1)) dates.push(d.toISOString().slice(0, 10));
const SLOTS = new Set(["PG", "SG", "G", "SF", "PF", "F", "C", "Util", "BN", "IL", "IL+"]);
const rows = [];
for (const date of dates) for (let t = 1; t <= teams; t++) {
  const html = await (await fetch(`/nba/${league}/${t}?date=${date}`, { credentials: "include" })).text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const seen = new Set();
  for (const r of doc.querySelectorAll("table tbody tr")) {
    const tds = [...r.querySelectorAll("td")];
    const slot = (tds[0]?.textContent || "").trim();
    if (!SLOTS.has(slot)) continue;
    // Find the cell by its link: its column differs between past days and today.
    const cell = tds.find((c) => c.querySelector('a[class*="name"]'));
    if (!cell) continue;
    const name = cell.querySelector('a[class*="name"]').textContent.trim();
    if (seen.has(name)) continue;
    seen.add(name);
    const rest = cell.textContent.replace(/\s+/g, " ").split(name).slice(1).join(name);
    const m = rest.match(/\b([A-Z]{2,4})\s*-\s*([A-Z]{1,2}(?:,[A-Z]{1,2})*)/);
    rows.push([date, t, `"${name}"`, m ? m[1] : "", m ? m[2].replace(/,/g, "/") : "", slot].join(","));
  }
}
window.__rows = rows;
const perDay = {};
for (const l of rows) { const d = l.slice(0, 10); perDay[d] = (perDay[d] || 0) + 1; }
JSON.stringify({ total: rows.length, perDay, noTeam: rows.filter((l) => l.split(",")[3] === "").length });
```

Every date should have about the same count and `noTeam` should be 0. A date with a much lower count means a team's
page didn't load or Yahoo's markup changed.

Save them:

- `rosters.csv`: header `team,player,nba_team,positions,slot`, then today's rows without the date column.
- `lineups.csv`: header `date,team,player,nba_team,positions,slot`, then every row dated before today. On the week's
  first day it's the header alone.

If the rows are too long to read in chunks, read today's rows in full, then only each earlier day's differences. Most
rows repeat, so this is far shorter:

```js
const R = window.__rows, today = "yyyy-mm-dd"; // the last date
const key = (l) => l.slice(11), who = (k) => k.split(",").slice(0, 2).join(",");
const latest = R.filter((l) => l.startsWith(today)).map(key), same = new Set(latest), out = [];
for (const d of [...new Set(R.map((l) => l.slice(0, 10)))].filter((d) => d !== today)) {
  const day = R.filter((l) => l.startsWith(d)).map(key), names = new Set(day.map(who));
  for (const k of day) if (!same.has(k)) out.push(`${d},${k}`);
  for (const k of latest) if (!names.has(who(k))) out.push(`-${d},${who(k)}`);
}
window.__today = latest; window.__diff = out;
JSON.stringify({ today: latest.length, diff: out.length });
```

A plain row replaces or adds that player on that date; a `-` row means today's player wasn't on that team that date.
Rebuild each day locally from today's rows, and check its count against `perDay` before writing `lineups.csv`.

Finally set `today` in `league.json`. Do this last: it's what tells the import the rosters are current.

## 6. Dry run

Confirm which database with the user. Importing into production needs `players` and game stats loaded there
(README, "Deploying"). For Railway, open the tunnel in the background and send its output to a file in your scratchpad,
so the password stays out of the chat:

```bash
railway connect Postgres --tunnel-only --port 6543
```

Pass the URL it prints as `DATABASE_URL` for the import only. It overrides `.env`; leaving it off imports into whatever
`.env` points at. Never print the URL, and delete the output file afterwards.

```bash
DATABASE_URL="<tunnel url>" npm run yahoo:import -- <folder>
```

Fix every error. For unmatched players, fill in their ids in `player-overrides.csv`, which the run creates in the
folder, then run again. Report the warnings to the user:

- **"can't play ... here; on the bench today"**: Yahoo's positions are wider than ours. The starter moves to the bench
  today only; earlier days keep their lineups.
- **"roster is illegal here"**: an IL player no longer qualifies. That team can't add or claim until it's fixed.

"There's already a season league" means production has one. Stop and ask before using `--replace`. "The snapshot is
from ..." means `today` is stale: refresh rather than reaching for `--stale-ok`, unless the user chooses it.

## 7. Apply

Only after a clean dry run and the user's go-ahead. Add `--replace` only if a league already exists and the user has
said to replace it.

```bash
DATABASE_URL="<tunnel url>" npm run yahoo:import -- <folder> --apply
```

The import is one transaction, so an error or a dropped tunnel saves nothing. Afterwards, check the team, roster and
week counts in the database, and that the site loads.

## 8. Close the tunnel

Interrupt `railway` with Ctrl-C (`kill -INT`). Its SSH process can outlive it, so check the port:

```bash
lsof -nP -iTCP:6543 -sTCP:LISTEN
```

If that still lists an `ssh` forwarding 6543, stop that process. Don't report the tunnel closed until this prints
nothing. Delete any scratch file holding the URL.

## If it breaks

- **Row counts look wrong, or `nba_team` is blank:** Yahoo changed its markup. Look at one row with
  `document.querySelector("table tbody tr").innerText` and update the selectors here.
- **`noId` is above 0 or the team count looks wrong:** check the Managers table's columns against step 2.
- **Yahoo's API is back:** prefer `npm run yahoo:export`, which also brings transactions and waivers (README).

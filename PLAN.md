# Fantasy Hoops – Project Plan

A self-hosted fantasy basketball app for one 12-team league. We're replacing Yahoo because its settings aren't configurable enough. Planned in a Claude chat; this file is the handoff to Claude Code.

## Goals

**Why we're building this (later milestones):**
- Configurable **waiver processing time** each day (a scheduled job in our own app).
- Configurable **IL eligibility rules** (when a player may move into an IL spot).
- No draft room. Leagues are initialized by setting rosters manually.

**Scoring format:** standard **9-category**: FG%, FT%, 3PM, PTS, REB, AST, STL, BLK, TO (TO is lower-is-better).

## Milestone 1 (current scope)

Hit the data API and show every player's **per-game season averages** in a table. Clicking a player opens a modal with their **game log** (shown first) and **past seasons**.

- **Table:** rank, player (headshot, name, team · position), GP, MIN, then the nine categories. Includes search and a position filter, sorted by 9CAT value. Shows per-game averages, with a Per game / Totals toggle (Per game is the default). Paginated.
- **Modal:** header (headshot, name, team · position, availability chip), a 9CAT summary strip for the season, a game log table for the season, and a past-seasons table.
- **Not in M1:** live scores, injuries, waivers, leagues, rosters, auth.
- **Design mockup:** https://claude.ai/artifact/3ZpzKr2ULidGFpMvgVcvAm (private to the owner; the table page and the modal state). Look: warm off-white background, dark ink, burnt-orange accent (#C2410C), Barlow Condensed headings, Inter body, tabular numerals. Mockup data is fictional and labeled "Sample data".

## Stack

- Next.js (App Router) + TypeScript, plain CSS (no Tailwind), `src/` dir.
- Postgres (local via `docker compose`, hosted on Railway later, ~$5/mo).
- Node 20+. Python 3 only for the headshot-mapping script (`pip install nba_api`).
- Users read from **our database**, never from the API directly. A background worker writes to the DB.

## Data source: BALLDONTLIE (ALL-STAR tier, $9.99/mo)

- Base URL (verify against docs): `https://api.balldontlie.io/v1`. Auth: `Authorization: <key>` header. Rate limit on ALL-STAR: 60 requests/min (trial: 5/min).
- `/games`: scores, status, period and clock. Real-time for in-progress games.
- `/stats`: per-player stat lines (the data behind live scoring and game logs). Real-time for in-progress games. Filters: `dates[]`, `seasons[]`, `game_ids[]`, `player_ids[]`, `per_page` (max 100). Needs the ALL-STAR tier.
- `/player_injuries`: `status` (probably just Out / Day-To-Day), `return_date` (a text string with no year), `description` (free text with questionable/probable/doubtful wording). Needs ALL-STAR.
- `/season_averages` is GOAT-only ($39.99), so **we compute averages ourselves** from stored game logs. FG% and FT% come from summed makes / summed attempts, never an average of percentages.
- `season=2026` means the 2026-27 season.
- No headshots in this API (to be confirmed from real `/players` responses).

### Open questions to verify with real responses (see `data/samples/`)
1. Does `/stats` return rows for DNPs and for players who haven't entered a live game yet?
2. How quickly do `/stats` values update during live games?
3. Exact field names, types and nullability in `/players`, `/stats`, `/player_injuries`.
4. Is the base URL and auth header correct?

## Refresh strategy (for the later live-update worker)

| Data | Cadence |
|---|---|
| Games (scores/status) | every 1–5 min while any game is live |
| Player stats for live games | every 1–5 min during games; one more pull the next morning for stat corrections |
| Injuries | every ~15 min on game days; store every status change with a timestamp |
| Players, schedule | once or twice daily |

Roughly 1,000–1,500 calls/day at the aggressive end, well within the limits.

## Headshots

- NBA CDN: `https://cdn.nba.com/headshots/nba/latest/{260x190|1040x760}/{NBA_PERSON_ID}.png`
- BALLDONTLIE has no NBA person ID, so write a **one-time mapping script** (`scripts/map-headshots.py` using `nba_api`): normalize names (lowercase, strip accents/punctuation/suffixes), match on name, break ties with team, store `nba_person_id` on each player, and print unmatched players for a manual override file. Re-run each season.
- The UI must **fall back to an initials circle** when the ID is missing or the image fails. The NBA CDN is not an official API, so don't depend on it.

## Rough build order

1. Run `scripts/fetch-samples.mjs` to save real responses to `data/samples/` and settle the open questions above.
2. Schema (players, teams, games, player_game_stats) and API client, based on the real responses.
3. Backfill script: pull `/stats` for the current and previous seasons into Postgres (a few hundred calls; respect the rate limit).
4. Season-averages query and JSON endpoints (`/api/players`, `/api/players/:id`).
5. Table UI, then the modal, matching the mockup.
6. Headshot mapping script and avatar component with fallback.
7. Deploy to Railway.

## Costs

About $15/month all-in (BALLDONTLIE ALL-STAR $9.99 + Railway ~$5), roughly $1.25 per person for 12 people. Can pause subscriptions in the offseason.

## Conventions and cautions

- Never commit `.env` or the API key. Confirm with `git check-ignore .env`.
- Keep the API client behind one module so the provider can be swapped.
- Make the IL rule and waiver time configurable data, not hardcoded.
- Be careful about API terms of service if this ever grows beyond a private league.

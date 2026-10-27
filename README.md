# fantasy-hoops

A self-hosted fantasy basketball app for one 12-team, 9-category league (FG%, FT%, 3PM, PTS, REB, AST, STL, BLK,
TO). It replaces Yahoo so the league can set its own waiver schedule (or FAAB), IL rules and game limits. There's
no draft room: rosters are set up directly.

Pages: Players (season stats, 9CAT value with punt weights, player modal with news and game log), Roster
(lineups, add/drop, waiver claims), Matchup, League (standings and recent transactions), Rankings (power rankings),
Box scores, trades (built from another team's page, with a review period), and the commissioner's League
settings. Playoffs and a toilet bowl run themselves once the regular season ends.

Stats come from [BALLDONTLIE](https://www.balldontlie.io) into our Postgres database; the app only reads the
database, and a background worker keeps it current. Player news comes from ESPN's public fantasy endpoints.

## Requirements

- Node.js 20+
- PostgreSQL 16 (Postgres.app, Homebrew, or Docker via the included `docker-compose.yml`)
- A BALLDONTLIE API key on the ALL-STAR tier or higher (`/stats` returns 401 on the free tier)
- Python 3 (optional, only for headshots)

## 1. Install

```sh
npm install
cp .env.example .env
```

Edit `.env` and set `BALLDONTLIE_API_KEY`. Leave `BALLDONTLIE_RPM=60` for ALL-STAR (use `5` on the trial).
Never commit `.env`.

## 2. Start Postgres and create the schema

With Postgres.app or Homebrew, make sure the server is running, then:

```sh
createdb fantasy_hoops
npm run db:migrate
```

The default `DATABASE_URL=postgres://localhost:5432/fantasy_hoops` works for a local server.
`npm run db:migrate` applies any new files in `db/migrations/` and skips ones already applied;
`npm run db:migrate -- --status` lists them. To change the schema, add the next numbered file
there. Never edit one that has been committed.

With Docker instead:

```sh
docker compose up -d
```

and set `DATABASE_URL=postgres://postgres:postgres@localhost:5432/fantasy_hoops` in `.env` before running
`npm run db:migrate`.

## 3. Load data

```sh
npm run sync:players                      # teams and players (~1 minute)
npm run backfill -- --seasons 2026,2025   # games and stat lines (~8 minutes per full season)
npm run backfill -- --seasons 2024,2023   # optional: more past seasons for the player modal
```

The backfill is resumable: re-run the same command after an interruption and it continues where it stopped.
Finished seasons are skipped. Options: `--since YYYY-MM-DD`, `--force` (reload a season), `--skip-games`.

For local testing, `npm run db:seed:league` (after the backfill) creates a 12-team league with mock
managers and drafted rosters. Re-run it to reset the rosters; `-- --seed=7` gives a different draft.

## 4. Headshots (optional)

Without this step players show initials instead of photos.

```sh
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
.venv/bin/python scripts/map-headshots.py
```

Add `--dry-run` to preview without writing. Re-run after loading new players.

## 5. Run the app

```sh
npm run dev
```

Open http://localhost:3000.

**Signing in locally:** with `AUTH_MOCK=1` (the default in `.env.example`), or whenever `GOOGLE_CLIENT_ID` is
empty, sign-in goes to a mock page where you pick a test user instead of using Google. After
`npm run db:seed:league` you can sign in as any of the 12 managers; the first is the commissioner.

For a production build: `npm run build && npm start`.

## Keeping the current season up to date

Run the sync worker in a second terminal next to `npm run dev`:

```sh
npm run worker
```

It keeps the database current on its own, logging one line per pass:

| Task | Cadence | What it pulls |
|---|---|---|
| `live` | every 30 s while a game is live; otherwise every 30 min, or just after the next tip-off | today's and yesterday's games (scores, status, clock), and stat lines for games in progress or finished in the last 5 hours |
| `injuries` | every 15 min on game days, every 2 h otherwise | the injury report; a `player_injuries` row is added only when a player's report changes |
| `corrections` | once a day after 9 AM | the last 3 days of games and stat lines again, for stat corrections |
| `rosters` | every 12 h | teams, players and the season schedule (about 90 requests, 2 minutes) |
| `lineups` | every 15 min and just after midnight | database only: saves each team's lineup for every day through today, then processes trades whose review window has ended |
| `waivers` | at the league's waiver time, on its waiver days | database only: processes due claims (FAAB bids in a FAAB league) and clears players off waivers |
| `playoffs` | every 15 min and just after midnight | database only: after the regular season, creates the playoff and toilet bowl rounds as they come due |

Ctrl-C stops it after the current pass, and restarting is safe: each task's last run is saved in
`sync_state` (`worker:<task>`), so a restart doesn't redo the slow passes. `npm run worker -- --once`
runs every task once and exits. All tasks share one API client, so together they stay under
`BALLDONTLIE_RPM`. Optional settings in `.env`: `WORKER_LIVE_SECONDS` (default 30),
`WORKER_CORRECTIONS_HOUR` (default 9) and `WORKER_TIME_ZONE` (default `America/New_York`).
In production it runs as its own process (the `worker` service under Deploying).

To run the league jobs by hand (e.g. to test against the seeded league):

```sh
npm run waivers                             # the next scheduled waiver run, now
npm run waivers -- --at now                 # only claims and waivers already due (or --at <ISO time>)
npm run playoffs -- --today 2027-04-20      # create due playoff rounds as if it were this date
```

In dev the same jobs are also at `POST /api/dev/waivers?at=...` and `POST /api/dev/playoffs?today=...`.

Without the worker, `npm run backfill -- --seasons 2026` pulls in everything since the last run.

## Importing a league from Yahoo

Moves a Yahoo league over mid-season: the import replaces this season's league with the Yahoo league
as it stood when you exported it. Finished weeks keep Yahoo's results exactly; the current week and
everything after are scored here, starting from each team's Yahoo lineups so far. Managers sign in
with Google using the email you list for their team, and land on it.

One-time setup: create an app at https://developer.yahoo.com/apps/ with Fantasy Sports (Read)
permission and redirect URI `oob`, and put its `YAHOO_CLIENT_ID` and `YAHOO_CLIENT_SECRET` in `.env`.

```sh
npm run yahoo:export -- --league 12345          # Yahoo league id (in the league's URL)
```

The first run asks you to sign in to Yahoo and paste back a code. It saves the league to
`yahoo-export/12345/` (gitignored) and writes `members.csv` there: fill in each manager's Gmail
(several emails for co-managers go in one cell, separated by `;`) and mark the commissioner. You can
also add `league-settings.json` there for settings Yahoo doesn't have, in the shape the
`/api/league/settings` endpoint returns under `settings` (e.g. `{"timeZone": "America/Los_Angeles",
"gameLimits": {"total": 40, "slots": {}}}`); it goes on top of Yahoo's settings.

```sh
npm run yahoo:import -- yahoo-export/12345                    # dry run: report only
npm run yahoo:import -- yahoo-export/12345 --apply --replace  # replace the season's league with it
```

The dry run lists what it would do and any problems: Yahoo players it couldn't match to ours (add
their ids to `player-overrides.csv`, which it fills with the unmatched ones), starters whose Yahoo
position doesn't fit ours (they go to the bench), illegal rosters, teams with no email. Point
`DATABASE_URL` at production to import there. You can import as often as you like (a practice run
now, the real one on moving day); each run starts over from the snapshot, but users and sign-ins
are kept. Export and import on the same day: the import refuses a snapshot from an earlier day.
Not imported: pending trades and waiver claims (managers resubmit them), lineups set for future
days, and playoff brackets (import before the playoffs).

## Deploying (Railway)

One Railway project with three services, all deploying from `main`:

| Service | Config file | Runs |
|---|---|---|
| `web` | `railway/web.json` | `npm run db:migrate` before each deploy, then `npm run build` / `npm run start` |
| `worker` | `railway/worker.json` | `npm run worker` (no build step; exactly one replica) |
| `Postgres` | Railway's PostgreSQL template | |

1. **New Project → Deploy from GitHub repo** → this repo. Rename the service `web`. Then
   **+ Create → Database → PostgreSQL**, and **+ Create → GitHub Repo** → this repo again, named `worker`.
2. In each app service's **Settings → Config-as-code**, set the path to `railway/web.json` or `railway/worker.json`.
3. Variables (Shared Variables, or set on both `web` and `worker`):
   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   BALLDONTLIE_API_KEY=...
   BALLDONTLIE_BASE_URL=https://api.balldontlie.io/v1
   BALLDONTLIE_RPM=60
   WORKER_TIME_ZONE=America/New_York
   ```
   `web` also needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `APP_URL=https://<domain>`. Leave `AUTH_MOCK`
   unset (it's ignored in production builds anyway).
4. `web` → **Settings → Networking → Generate Domain** (or add a custom domain), and add
   `https://<domain>/api/auth/google/callback` as a redirect URI on the Google OAuth client.
5. Load data from your machine against the Postgres service's `DATABASE_PUBLIC_URL` (its Variables tab):
   ```sh
   DATABASE_URL="<public url>" npm run sync:players
   DATABASE_URL="<public url>" npm run backfill -- --seasons 2026,2025
   .venv/bin/python scripts/map-headshots.py --database-url "<public url>"
   ```
   Don't run `db:seed:league` against production: it creates mock managers.

After that, every push to `main` redeploys both services, and the worker keeps the data current.
For debugging, `railway logs --service worker` (Railway CLI) or the Railway MCP server shows each service's logs.

## Checks

```sh
npm run typecheck
npx tsx --test 'src/**/*.test.ts'
npm run build
```

## Troubleshooting

- **`node`, `npm` or `psql` not found:** Node or Postgres isn't on your `PATH`. If Node was installed from
  the nodejs.org tarball into `~/.local/node` and Postgres is Postgres.app, add this to `~/.zshrc`:
  ```sh
  export PATH="$HOME/.local/node/bin:/Applications/Postgres.app/Contents/Versions/16/bin:$PATH"
  ```
- **`ECONNREFUSED` on port 5432:** Postgres isn't running. Open Postgres.app, or for a cluster you created
  yourself: `pg_ctl -D "<data dir>" -l "<data dir>/server.log" start`.
- **`401 Unauthorized` from scripts:** the API key is missing from `.env` or isn't on the ALL-STAR tier.
- **Port 3000 in use:** `npm run dev -- --port 3001`.

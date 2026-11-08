# fantasy-hoops

A self-hosted fantasy basketball app for one 12-team, 9-category league (FG%, FT%, 3PM, PTS, REB, AST, STL, BLK,
TO). It replaces Yahoo so the league can set its own waiver schedule (or FAAB), IL rules and game limits. There's
no draft room: rosters are set up directly.

Pages: Players (season stats, 9CAT value with punt weights, a watchlist, player modal with news and game log), Roster
(lineups, add/drop, waiver claims), Matchup, League (standings and recent transactions), Rankings (power rankings),
Box scores, trades (built from another team's page, with a trade analyzer and a review period), and the commissioner's League
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

## Injury alerts (push notifications)

Managers can get a phone or desktop notification when a player on their roster gets a worse injury status
(e.g. Questionable → Out, or healthy → Day-To-Day) or is healthy again (off the report), even with the site
closed. Partial upgrades (Out → Questionable) don't send one. The worker's `injuries` task sends
them after each injury sync (`src/lib/push/`); each manager turns them on per browser or device from the account
menu (**Injury alerts**), which sends a confirmation notification.

Setup, once:

1. Generate a VAPID key pair (it identifies this server to the browsers' push services; no account needed):
   ```sh
   npx web-push generate-vapid-keys
   ```
2. Put both keys and a contact in `.env` (locally), and on both `web` and `worker` in Railway (Variables):
   ```
   VAPID_PUBLIC_KEY=<Public Key>
   VAPID_PRIVATE_KEY=<Private Key>
   VAPID_SUBJECT=mailto:you@example.com
   ```
   Keep the pair forever: browsers subscribe to the public key, so a new pair breaks every saved subscription
   (managers would have to turn alerts off and on again). The private key is a secret; never commit it.
3. Redeploy both services. Until both keys are set, the menu hides the toggle and the worker sends nothing.

Where it works: desktop Chrome, Edge, Firefox and Safari (the browser must be running, not a tab); Android Chrome
and Firefox. On iPhone and iPad (iOS 16.4+), only from the Home Screen: Share → **Add to Home Screen**, open it from
there, then turn on **Injury alerts**; in a Safari tab the menu explains this. Push needs https (or localhost).

## Importing a league from Yahoo

Moves a Yahoo league over mid-season: the import replaces this season's league with the Yahoo league
as it stood on the day its CSVs were copied from the league's Yahoo pages. Finished weeks keep Yahoo's
results exactly; the current week and everything after are scored here, starting from each team's Yahoo
lineups so far. Managers sign in with Google using the email you list for their team, and land on it.

The import reads a folder of CSVs (keep it under `yahoo-export/`, which is gitignored: it holds manager emails):

| File | Contents |
|---|---|
| `league.json` | `{"name", "season": 2026, "today": "yyyy-mm-dd", "rosterSlots": {"PG": 1, ..., "BN": 3, "IL": 2}, "playoffStartWeek"}`; `today` is the day `rosters.csv` shows |
| `teams.csv` | `team,name,abbreviation,email,commissioner,waiver_priority,faab_balance` (`team` is a short id the other files use; several emails for co-managers go in one cell, separated by `;`) |
| `schedule.csv` | `week,start,end,team_a,team_b`, one row per matchup |
| `results.csv` | `week,team,fgm,fga,ftm,fta,fg3m,pts,reb,ast,stl,blk,tov` for every finished week |
| `rosters.csv` | `team,player,nba_team,positions,slot`: today's rosters and lineup slots |
| `lineups.csv` | optional, `date,team,player,nba_team,positions,slot`: this week's other days, earlier ones and any set ahead, so the whole week is scored as Yahoo has it |
| `transactions.csv` | optional, `id,at,type,player,nba_team,positions,from_team,to_team,faab_bid`: completed adds, drops, claims and trades, one row per player moved (rows sharing an `id` are one transaction; `at` is `yyyy-mm-dd HH:MM` in `league.json`'s `transactionsTimeZone`, else the league's; Yahoo shows times in the viewing device's zone) |

You can also add `league-settings.json` for settings Yahoo's pages don't give, in the shape the
`/api/league/settings` endpoint returns under `settings` (e.g. `{"timeZone": "America/Los_Angeles",
"gameLimits": {"total": 40, "slots": {}}}`); it goes on top of `league.json`'s settings.
To build or refresh the folder from Yahoo's pages, run the `/yahoo-csv-refresh <league-id>` skill in Claude Code
([.claude/skills/yahoo-csv-refresh/SKILL.md](.claude/skills/yahoo-csv-refresh/SKILL.md)).

```sh
npm run yahoo:import -- yahoo-export/12345-csv                    # dry run: report only
npm run yahoo:import -- yahoo-export/12345-csv --apply --replace  # replace the season's league with it
```

The dry run lists what it would do and any problems: errors in the files, Yahoo players it couldn't match to
ours (add their ids to `player-overrides.csv`, which it fills with the unmatched ones), starters whose Yahoo
position doesn't fit ours (they keep Yahoo's lineup through this week, then go to the bench), illegal rosters, teams with no email. Point
`DATABASE_URL` at production to import there. You can import as often as you like (a practice run
now, the real one on moving day); each run starts over from the files, but users and sign-ins
are kept. Copy and import on the same day: the import refuses rosters from an earlier day.
Transactions become the league's history, count toward each team's add limits, and put players dropped within
the waiver period back on waivers. Not imported: pending trades and waiver claims (managers resubmit them),
lineups set ahead past this week, and playoff brackets (import before the playoffs).

## Deploying (Railway)

One Railway project with three services, all deploying from `main`. `.railway/railway.ts` (Railway's Infrastructure
as Code) defines them:

| Service | Runs |
|---|---|
| `web` | `npm run db:migrate` before each deploy, then `npm run build` / `npm run start` |
| `worker` | `npm run worker` (no build step; exactly one replica) |
| `Postgres` | Railway's PostgreSQL |

Railway doesn't read the file on deploy. Changes to it go out with `railway config apply`; pushes to `main` only
redeploy the code.

1. Install the Railway CLI (5.42.1 or newer: `brew install railway`), then `railway login`. Create an empty project
   in the dashboard (or `railway init`) and `railway link` this checkout to it. Railway needs GitHub access to the repo.
2. Preview, then apply:
   ```sh
   railway config plan
   railway config apply
   ```
   The plan should create `web`, `worker` and `Postgres` (or, for an existing project, change only what you expect).
3. Secrets aren't in the file (they're `preserve()`): set them in the dashboard under each service's Variables:
   `BALLDONTLIE_API_KEY` and the three `VAPID_*` keys (see "Injury alerts") on `web` and `worker`, and
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` on `web`.
4. `web` → **Settings → Networking → Generate Domain** (or add a custom domain), and add
   `https://<domain>/api/auth/google/callback` as a redirect URI on the Google OAuth client. The app uses Railway's
   domain (`RAILWAY_PUBLIC_DOMAIN`) as its origin; set `APP_URL` only to use a different one.
5. Load data from your machine through an SSH tunnel to Postgres (it has no public address). In one terminal:
   ```sh
   railway connect Postgres --tunnel-only --port 6543
   ```
   It prints the connection details and holds the tunnel open until Ctrl-C. In another, with that URL:
   ```sh
   DATABASE_URL="postgres://postgres:<password>@localhost:6543/railway" npm run sync:players
   DATABASE_URL="postgres://postgres:<password>@localhost:6543/railway" npm run backfill -- --seasons 2026,2025
   .venv/bin/python scripts/map-headshots.py --database-url "postgres://postgres:<password>@localhost:6543/railway"
   ```
   The backfill is resumable, so re-run it if the tunnel drops. Don't run `db:seed:league` against production: it
   creates mock managers.

After that, every push to `main` redeploys both services, and the worker keeps the data current.
For debugging, `railway logs --service worker` or the Railway MCP server shows each service's logs.

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

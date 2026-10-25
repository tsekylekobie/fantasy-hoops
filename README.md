# fantasy-hoops

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

For a production build: `npm run build && npm start`.

## Keeping the current season up to date

New games are not loaded automatically yet. To pull in games since the last run:

```sh
npm run backfill -- --seasons 2026
```

## Checks

```sh
npm run typecheck
npx tsx --test src/lib/queries/*.test.ts
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

# Fantasy Hoops

See PLAN.md for the product plan. Milestone 1: players table + player modal.

## Layout
- `src/lib/types.ts`: the API contract between routes and UI. Change both sides together.
- `src/lib/bdl/`: the only module that talks to BALLDONTLIE (keeps the provider swappable).
- `src/lib/db.ts`: shared `pg` pool. `db/schema.sql`: idempotent schema (`npm run db:migrate`).
- `src/app/api/players/`: JSON endpoints. Users read from our DB, never the API directly.
- `src/components/`: UI. `Avatar` must fall back to initials.
- `docs/design/*.mockup.html`: the design mockups (table page and modal) to match.
- `scripts/`: one-off and batch jobs (run with `tsx`); `scripts/map-headshots.py` is the only Python.

## Conventions
- TypeScript strict, plain CSS (CSS modules or globals.css tokens). No Tailwind, no UI libraries.
- FG%/FT% = summed makes / summed attempts, never an average of percentages. TO is lower-is-better.
- `season=2026` means 2026-27.
- Never commit `.env` or API keys. Secrets come from `.env` (see `.env.example`).
- Local tools are not on the default PATH. Prefix commands with
  `export PATH="$HOME/.local/node/bin:/Applications/Postgres.app/Contents/Versions/16/bin:$PATH"`.
  Node 22 lives in `~/.local/node`; Postgres 16 is Postgres.app, data in
  `~/Library/Application Support/Postgres/var-16`, database `fantasy_hoops` on localhost.
  Start it if needed: `pg_ctl -D "$HOME/Library/Application Support/Postgres/var-16" -l "$HOME/Library/Application Support/Postgres/var-16/server.log" start`.
- Before pushing: `npm run typecheck` and `npm run build` pass.

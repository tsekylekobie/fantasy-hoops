# Fantasy Hoops

See PLAN.md for the product plan. Milestone 1: players table + player modal.

## Layout
- `src/lib/types.ts`: the API contract between routes and UI. Change both sides together.
- `src/lib/bdl/`: the only module that talks to BALLDONTLIE (keeps the provider swappable).
- `src/lib/db.ts`: shared `pg` pool.
- `db/migrations/NNNN_name.sql`: the schema, applied in order by `npm run db:migrate` and tracked in
  `schema_migrations`. Never edit a migration that has been committed; add the next number instead.
  `scripts/dev/seed-league.ts` (`npm run db:seed:league`) seeds a 12-team league with mock managers.
- `src/app/api/players/`: JSON endpoints. Users read from our DB, never the API directly.
- `src/app/api/team/transactions/` + `src/lib/queries/transactions.ts`: add/drop. `src/lib/transactions/policy.ts`
  is the one place that decides immediate add vs. waiver claim (and where dropped players go).
- `src/components/`: UI. `Avatar` must fall back to initials.
- `docs/design/*.mockup.html`: the design mockups to match. M1 is `players-table` and `player-modal`; the others (my team, matchup, league, claim, nav map, phone) are later-milestone exploration.
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

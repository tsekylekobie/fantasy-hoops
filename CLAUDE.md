# Fantasy Hoops

See PLAN.md for the product plan. Milestone 1: players table + player modal.

## Layout
- `src/lib/types.ts`: the API contract between routes and UI. Change both sides together.
- `src/lib/bdl/`: the only module that talks to BALLDONTLIE (keeps the provider swappable).
- `src/lib/espn/news.ts`: player news from ESPN's keyless fantasy endpoints (Rotowire blurbs), matched by name and
  fetched live by `/api/players/[id]/news` with an in-memory cache. Not stored; the one exception to reading from our DB.
- `src/lib/db.ts`: shared `pg` pool.
- `db/migrations/NNNN_name.sql`: the schema, applied in order by `npm run db:migrate` and tracked in
  `schema_migrations`. Never edit a migration that has been committed; add the next number instead.
  `scripts/dev/seed-league.ts` (`npm run db:seed:league`) seeds a 12-team league with mock managers.
- `src/app/api/players/`: JSON endpoints. Users read from our DB, never the API directly.
- `src/app/api/team/transactions/` + `src/lib/queries/transactions.ts`: add/drop. `src/lib/transactions/policy.ts`
  is the one place that decides immediate add vs. waiver claim (and where dropped players go).
- `src/lib/queries/waivers.ts`: the daily waiver run (worker task `waivers`, at `leagues.waiver_time` in its time zone),
  claims (`/api/team/claims`) and the waiver order. Run by hand: `npm run waivers -- --at next|now|<ISO>` or
  `POST /api/dev/waivers?at=...` (dev only). FAAB (`waiver_type = 'faab'`): `resolveClaims` there (pure, tested) orders
  claims by bid, breaks ties on priority and charges `fantasy_teams.faab_balance`; bids are checked by `faabBidProblem`
  in `policy.ts`. Each claim records the run that decided it (`transactions.waiver_run_id`); Recent transactions shows
  one summary per run (`getRecentTransactions` in `queries/league.ts`).
- `src/lib/queries/settings.ts` + `/api/league/settings` + `/league/settings`: the commissioner's league settings
  (`leagues.commissioner_user_id` only). Waivers run on `leagues.waiver_days_of_week` (ISO weekdays, migration 0009).
- `src/lib/playoffs/bracket.ts`: playoff and toilet bowl rules (seeding, pairings, who advances, ties go to the better
  seed). `src/lib/queries/playoffs.ts` `syncPlayoffs` is the one place that creates bracket matchups (worker task
  `playoffs`; by hand `npm run playoffs -- --today <yyyy-mm-dd>` or `POST /api/dev/playoffs?today=...`, dev only).
  Standings count regular-season weeks only (`src/lib/queries/standings.ts`).
- `src/lib/queries/injuries.ts`: current injury per player (`getInjuries`) and parsing the provider's description into
  injury + news blurb. Rows show the status chip; the player modal adds injury, est. return and the full news blurb.
- `src/lib/queries/rankings.ts` + `/rankings`: power rankings. Every team's week against every other team's (all-play),
  for one week or the regular season added up; Versus the league shows one team against each other team.
- `src/lib/lineup/rules.ts`: `ilEligibility` is the one place that evaluates the IL rule (the player's current injury
  status against `il_statuses` / `il_plus_statuses`); `rosterProblems` decides when a roster is illegal (blocks adds and claims).
- `src/lib/lineup/gameLimits.ts`: game limits (commissioner setting, off by default): caps on starters' games per matchup
  week, total and per starting slot, counted in tip-off order (`countStarts`, pure, tested). Each week carries its own
  limits (`league_weeks.game_limits`, migration 0015); saving settings copies them onto weeks not yet started, so a change
  starts next week. Matchup scoring (`queries/matchups.ts`: `weekLines`, used by standings, rankings and playoffs) applies
  them; My team shows games used (`teamGameLimitUsage`).
- `src/lib/queries/boxScores.ts` + `/box-scores`: every game's box score for a date (`?date=`). Each line's Value is one
  game scored against the season's pool (`gameScorer` in `value.ts`, your punt weights); `rankDay` (pure, tested) ranks
  every stat against all players who played that date, and the cells are shaded by that tier.
- `src/components/`: UI. `Avatar` must fall back to initials.
- Live updates: `src/components/live/`. While `live` is true (`queries/live.ts` `gamesInProgress`, on `MatchupWeek` and
  `TeamLineupResponse`), Matchup (`router.refresh`) and My team (refetch) poll every 30s; `Flash` highlights a cell whose
  value changed (not on first render, from null, or when its `scope`, e.g. the player in the row, changed).
- `docs/design/*.mockup.html`: the design mockups to match, copied from the design canvas (PLAN.md links it). M1 is `players-table` and `player-modal`;
  `league-settings` is the commissioner's /league/settings; `my-team`, `matchup`, `league`, `rankings`, `claim-player`, `trade-builder`,
  `edit-team`, `nav-map` and `my-team-phone` follow the built pages. Not built yet: `sign-in-flow`, `sign-in`, `welcome`, `not-in-league`
  and `league-members` (a league email list), the League page's Schedule/Transactions tabs, and My team's summary cards.
- `railway/`: Railway config-as-code for the `web` and `worker` services (README, "Deploying"). Anything a
  script needs at runtime (`tsx`, `dotenv`) belongs in `dependencies`, not `devDependencies`.
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

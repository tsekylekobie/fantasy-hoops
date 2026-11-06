# Fantasy Hoops

A self-hosted fantasy basketball app for one 12-team, 9-category league (FG%, FT%, 3PM, PTS, REB, AST, STL, BLK, TO),
built to replace Yahoo with configurable waivers, IL rules and game limits. README.md covers setup, the worker and deploying.
Data comes from BALLDONTLIE's ALL-STAR tier (60 requests/min); `/season_averages` isn't on it (averages are computed from
stored game logs), and neither is `/plays` (no play-by-play).

## Layout
- `src/lib/types.ts`: the API contract between routes and UI. Change both sides together.
- `src/lib/bdl/`: the only module that talks to BALLDONTLIE (keeps the provider swappable).
- `src/lib/espn/news.ts`: player news from ESPN's keyless fantasy endpoints (Rotowire blurbs), matched by name and
  fetched live by `/api/players/[id]/news` with an in-memory cache. Not stored; the one exception to reading from our DB.
- `src/lib/db.ts`: shared `pg` pool.
- Sign-in: `src/lib/auth/oidc.ts` (Google, OpenID Connect; `profileFromClaims` pure, tested) behind
  `/api/auth/[provider]/start|callback`; a provider's button shows once its client id and secret are set. Each provider
  account is a `user_identities` row (migration 0022); `signInUser` (`auth/session.ts`) joins a new one to the user
  with the same verified email (Yahoo sign-in was tried and removed; old `yahoo` rows are inert), and only a verified email links league teams (`linkMemberships`).
- `db/migrations/NNNN_name.sql`: the schema, applied in order by `npm run db:migrate` and tracked in
  `schema_migrations`. Never edit a migration that has been committed; add the next number instead.
  `scripts/dev/seed-league.ts` (`npm run db:seed:league`) seeds a 12-team league with mock managers.
- `src/app/api/players/`: JSON endpoints. Users read from our DB, never the API directly.
- `src/app/api/team/transactions/` + `src/lib/queries/transactions.ts`: add/drop. `src/lib/transactions/policy.ts`
  is the one place that decides immediate add vs. waiver claim (and where dropped players go). FAAB alone doesn't make
  free agents claims; `leagues.all_adds_by_claim` (commissioner setting, off by default, migration 0021) does.
- `src/lib/queries/waivers.ts`: the daily waiver run (worker task `waivers`, at `leagues.waiver_time` in its time zone),
  claims (`/api/team/claims`) and the waiver order. Run by hand: `npm run waivers -- --at next|now|<ISO>` or
  `POST /api/dev/waivers?at=...` (dev only). FAAB (`waiver_type = 'faab'`): `resolveClaims` there (pure, tested) orders
  claims by bid, breaks ties on priority and charges `fantasy_teams.faab_balance`; bids are checked by `faabBidProblem`
  in `policy.ts`. Each claim records the run that decided it (`transactions.waiver_run_id`); Recent transactions shows
  one summary per run (`getRecentTransactions` in `queries/league.ts`).
- Trades: `src/lib/queries/trades.ts` (propose, accept, review, process; built from another team's page,
  `src/components/trades/`). A team over the active limit after a trade drops players with it
  (`transaction_players.to_team_id` NULL): the proposer picks when proposing, the partner when accepting.
  The trade analyzer (`TradeAnalysis.tsx`, in the builder and under open trades) prices trades on the client with
  `src/lib/trades/analysis.ts` (pure, tested) over `GET /api/trades/analysis` (`queries/tradeAnalysis.ts`).
- `src/lib/queries/settings.ts` + `/api/league/settings` + `/league/settings`: the commissioner's league settings
  (`leagues.commissioner_user_id` only). Waivers run on `leagues.waiver_days_of_week` (ISO weekdays, migration 0009).
- `src/lib/playoffs/bracket.ts`: playoff and toilet bowl rules (seeding, pairings, who advances, ties go to the better
  seed). `src/lib/queries/playoffs.ts` `syncPlayoffs` is the one place that creates bracket matchups (worker task
  `playoffs`; by hand `npm run playoffs -- --today <yyyy-mm-dd>` or `POST /api/dev/playoffs?today=...`, dev only).
  Standings count regular-season weeks only (`src/lib/queries/standings.ts`). The League page's scoreboard pages through
  every week (`?week=N`, default this week; only the scoreboard changes, standings stay current).
- `src/lib/queries/injuries.ts`: current injury per player (`getInjuries`) and parsing the provider's description into
  injury + news blurb. Rows show the status chip ("Out 3W": time to the est. return, `fmtInjuryStatus` in `components/players/format.ts`); the player modal adds injury, est. return and the full news blurb.
- `src/lib/queries/watchlist.ts`: each user's watchlist (`player_watchlist`, migration 0018). The star (`WatchStar`) on
  Players rows and in the player modal toggles it via `PUT`/`DELETE /api/players/[id]/watch`; `scope=watch` on
  `/api/players` lists it. `watched` on rows and player detail is null when signed out (no star).
- `src/lib/queries/rankings.ts` + `/rankings`: power rankings. Every team's week against every other team's (all-play),
  for one week or the regular season added up; Versus the league shows one team against each other team.
- `src/lib/lineup/rules.ts`: `ilEligibility` is the one place that evaluates the IL rule (the player's current injury
  status against `il_statuses` / `il_plus_statuses`); `rosterProblems` decides when a roster is illegal (blocks adds and claims;
  with `leagues.claims_ignore_il_status`, migration 0019, the waiver run skips its IL check so a status change doesn't fail a pending claim).
- `src/lib/lineup/gameLimits.ts`: game limits (commissioner setting, off by default): caps on starters' games per matchup
  week, total and per starting slot, counted in tip-off order (`countStarts`, pure, tested). Each week carries its own
  limits (`league_weeks.game_limits`, migration 0015); saving settings copies them onto weeks not yet started, so a change
  starts next week. Matchup scoring (`queries/matchups.ts`: `weekLines`, used by standings, rankings and playoffs) applies
  them; My team shows games used (`teamGameLimitUsage`).
- `src/lib/queries/projections.ts`: the Matchup page's Projected view (`?view=projected`): the week so far plus each
  start still to tip off that will count (lineups as set, game limits applied) at the player's last-30-day average
  (5+ games, else season); players listed Out add nothing until their return. `getMatchupWeek` applies it.
  The Categories table's Win chance row (`components/matchup/categoryOdds.ts`, pure, tested): each category's chance of
  winning by week's end, the projected margin over a spread that grows with what's left to play (projected minus actual);
  toss-ups (35–65%) are shaded loudest, 90%+ either way fades. Hidden once the week is final.
- Players page filters: Injured hides players listed Out by default (`?injured=show` in the page URL turns that off; the API's
  `injured=hide` defaults to showing them).
- Players page ranges: season, last 30 and last 14 days (`statWindow` in `queries/players.ts`); the player modal shows
  his rank in each (`PlayerDetailResponse.ranks`, the signed-in user's punt weights).
  Past seasons show his rank each season at `DEFAULT_WEIGHTS` (`pastSeasonRanks`, cached in memory).
  Stat cells and Value are shaded with Box scores' tiers (`tierOf`), placed among the valuation pool's per-game
  z-scores (`Valuation.tiers` in `value.ts`, `PlayerRow.tiers`), so green/red means better/worse than a rostered player.
  In Totals mode the stats are placed among the pool's season totals instead (`totalTiers`; FG%/FT% by total impact),
  so fewer games ranks lower; Value stays per game.
- NBA trades: `players.team_id` is only the current team; each stat line keeps the team he played for. Anything that
  finds a player's game on a past date uses `player_team_on(player, date)` (migration 0020), not `players.team_id`.
- `src/lib/queries/boxScores.ts` + `/box-scores`: every game's box score for a date (`?date=`). Each line's Value is one
  game scored against the season's pool (`gameScorer` in `value.ts`, your punt weights); `rankDay` (pure, tested) ranks
  every stat against all players who played that date, and the cells are shaded by that tier. Every game stays listed:
  clicking one in the scoreboard scrolls to it, and once the scoreboard scrolls off a compact copy pins to the top
  (`--sticky-head-top` drops the tables' pinned headers below it).
- Yahoo import (README, "Importing a league from Yahoo"): no Yahoo API (sign-in or Fantasy); `scripts/yahoo/import.ts`
  replaces the season's league from a folder of CSVs (dry run unless `--apply`) read by `src/lib/yahoo/csv.ts`
  (pure, tested; README has the formats; the `yahoo-csv-refresh` skill builds them from Yahoo's pages). The snapshot
  shape and player matching are in `src/lib/yahoo/parse.ts` (pure, tested). Imported finished weeks keep Yahoo's
  totals in `week_results` (migration 0017), which `weekLines` and the Matchup page use instead of computing the week.
  `league_members` maps manager emails to teams; sign-in links them (`src/lib/auth/members.ts`).
- Privacy: league data (rosters, owners, waivers, matchups, standings, rankings, trades, transactions, team logos) is
  signed-in only. Signed out, the header shows League (a sign-in prompt), Players and Box scores; Players hides the
  league filters and Owner column, Box scores its Owner column, and the routes strip `owner`/`waiver`/`thisWeek`/
  `transactions`. League-only pages call `requireSignedInPage` (`src/lib/auth/viewer.ts`, redirects to /league). The root
  layout reads the session once (`currentSession`) into `SessionProvider` (`useSignedIn` on the client).
- `src/components/`: UI. `Avatar` must fall back to initials. Wide tables (Players, Box scores) use
  `table/StickyHeadTable` (sideways scroll, header pinned to the page via a measured copy, `data-scrolled` once
  scrolled) and `players/ScrollName` (names shorten to "S. Gilgeous-Alexander" while scrolled).
- Live updates: `src/components/live/`. While `live` is true (`queries/live.ts` `gamesInProgress`, on `MatchupWeek` and
  `TeamLineupResponse`), Matchup (`router.refresh`) and My team (refetch) poll every 30s; `Flash` highlights a cell whose
  value changed (not on first render, from null, or when its `scope`, e.g. the player in the row, changed).
- `docs/design/*.mockup.html`: the design mockups to match, copied from the design canvas (https://claude.ai/artifact/3ZpzKr2ULidGFpMvgVcvAm, private to the owner).
  `players-table` and `player-modal` are the Players page;
  `league-settings` is the commissioner's /league/settings; `my-team`, `matchup`, `league`, `rankings`, `claim-player`, `trade-builder`, `trade-analyzer`,
  `edit-team`, `nav-map` and `my-team-phone` follow the built pages. Not built yet: `sign-in-flow`, `sign-in`, `welcome`, `not-in-league`
  and `league-members` (a league email list), the League page's Schedule/Transactions tabs, and My team's summary cards.
- `.railway/railway.ts`: Railway Infrastructure as Code for `web`, `worker` and `Postgres` (README, "Deploying");
  applied with `railway config apply`, not on deploy. Secrets are `preserve()`, set in the dashboard. Anything a
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

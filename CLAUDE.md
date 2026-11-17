# Fantasy Hoops

A self-hosted fantasy basketball app for one 12-team, 9-category league (FG%, FT%, 3PM, PTS, REB, AST, STL, BLK, TO),
run on Yahoo. The league is managed on Yahoo; League, My team, team pages and Matchup are read-only mirrors of what the
DB holds (which the Yahoo sync fills): no lineup edits, adds/drops, claims, trades or settings changes here.
README.md covers setup, the worker and deploying.
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
- Transactions (display only): Recent transactions shows completed adds, drops, claims and trades, one "Waiver
  report" per waiver run (`transactions.waiver_run_id`, historical runs from before the app stopped running waivers),
  and groups claims without a run (imported, won and failed) by the minute they were decided (`transactionFeed` in
  `src/lib/transactions/feed.ts`, pure, tested; `finishReport` there words why each claim lost). A report's row lists
  only the claims won (failed ones show when it's expanded), and a run where nothing went through isn't listed. The
  League page shows the 5 latest (`getRecentTransactions` in `queries/league.ts`); `/league/transactions` pages through
  all of them (`?page=N`). `src/lib/queries/waivers.ts` is the League page's waiver order (`fantasy_teams.waiver_priority`,
  FAAB balances); `queries/waiverStatus.ts` says who's on waivers (Players, Box scores, the player modal show FA / W).
- `src/lib/queries/settings.ts` + `GET /api/league/settings` + `/league/settings`: "League rules", the league's settings
  as stored, read-only for every signed-in manager (`LeagueSettingsForm`, every control disabled). `parseSettings`
  validates a whole `LeagueSettings` (the Yahoo import uses it).
- `src/lib/playoffs/bracket.ts`: playoff and toilet bowl rules (seeding, pairings, who advances, ties go to the better
  seed). `src/lib/queries/playoffs.ts` builds the League page's Playoffs view from the bracket rows in `matchups`
  (Yahoo's; nothing here creates them), or a projection from today's standings before any exist.
  Standings count finished regular-season weeks only (not the live week) (`src/lib/queries/standings.ts`). The League page's scoreboard pages through
  every week (`?week=N`, default this week; only the scoreboard changes, standings stay current).
- `src/lib/queries/injuries.ts`: current injury per player (`getInjuries`) and parsing the provider's description into
  injury + news blurb. Rows show the status chip ("Out 3W": time to the est. return, `fmtInjuryStatus` in `components/players/format.ts`); the player modal adds injury, est. return and the full news blurb.
- Injury alerts (Web Push, README "Injury alerts"): the worker's `injuries` task gets each change from `recordInjuries`
  (with the status before it; none on the first sync) and `notifyInjuryChanges` (`src/lib/push/send.ts`) notifies the
  owners of rostered players whose status got worse or who are healthy again (`shouldAlert` in `push/injuryAlerts.ts`,
  pure, tested; not partial upgrades like Out → Questionable). Not watchlists. Browsers subscribe from the user menu (`components/PushToggle.tsx`, `/api/me/push`, `push_subscriptions`,
  migration 0023); `public/sw.js` shows them; `app/manifest.ts` is for iOS, where push needs Add to Home Screen.
  Off while `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` are unset.
- `src/lib/queries/watchlist.ts`: each user's watchlist (`player_watchlist`, migration 0018). The star (`WatchStar`), only
  in the player modal (not on Players rows), toggles it via `PUT`/`DELETE /api/players/[id]/watch`; `scope=watch` on
  `/api/players` lists it. `watched` on rows and player detail is null when signed out (no star).
- `src/lib/queries/rankings.ts` + `/rankings`: power rankings. Every team's week against every other team's (all-play),
  for one week or the regular season added up, ranked by all-play category win % (ties half; `RankingsRow.allPlayPct`,
  shown as the Score column ×100 and rounded, capped at 99: 0–99, 50 = even; category cells shaded by value, median gray); the stack rank sorts by any column (`?sort=&dir=`,
  `parseSort` in `RankingsView.tsx`; best first, # stays the power rank); Versus the league shows one team against each other team.
  A week with `week_results` rows (Yahoo's totals, final or not) ranks on those lines (`withWeekResults`); other weeks
  are computed from the lineups.
- `src/lib/lineup/rules.ts`: `ilEligibility` is the one place that evaluates the IL rule (the player's current injury
  status against `il_statuses` / `il_plus_statuses`); `rosterProblems` (illegal rosters) is only the Yahoo import's check now.
- `src/lib/lineup/gameLimits.ts`: game limits (a league setting, off by default): caps on starters' games per matchup
  week, total and per starting slot, counted in tip-off order (`countStarts`, pure, tested). Each week carries its own
  limits (`league_weeks.game_limits`, migration 0015). Matchup scoring (`queries/matchups.ts`: `weekLines`, used by standings, rankings and playoffs) applies
  them; My team shows games used (`teamGameLimitUsage`).
- `src/lib/queries/projections.ts`: the Matchup page's Projected view (`?view=projected`): the week so far plus each
  start still to tip off that will count (lineups as set, game limits applied) at the player's last-30-day average
  (5+ games, else season); players listed Out add nothing until their return. `getMatchupWeek` applies it.
  The Categories table's Win chance row (`components/matchup/categoryOdds.ts`, pure, tested): each category's chance of
  winning by week's end, the projected margin over a spread that grows with what's left to play (projected minus actual);
  shaded red to green by the chance. Hidden once the week is final.
- Player value and rank (`src/lib/queries/value.ts`, everywhere a Value or # shows: Players, player modal,
  box scores) are Josh Lloyd's DURANT H2H: each category Yeo–Johnson transformed and standardized over the
  156-player pool (`yeoJohnson.ts`, matches scikit-learn's PowerTransformer, tested), weighted by `DURANT_H2H_WEIGHTS`
  (PTS 1, REB 0.94, AST 0.75, the rest 0.6, TO excluded), without the user's punts, minus the worst category
  (Minus 1). `Valuation.z` and the cell tiers stay plain z-scores. Punts are checkboxes (`PuntWeights.tsx`, every
  category but TO), still stored as `CategoryWeights` (0 = punted, anything above 0 counts fully; old saved slider
  weights read that way).
  The Players page's DURANT / 9CAT switch (`?method=9cat`, `RankMethod`; on `/api/players` and `/api/players/[id]`
  for the modal's ranks) brings back the old valuation: `valuePlayers(..., "9cat")`, the weighted average of all nine
  z-scores, TO at its stored weight (0.3), no Minus 1. Box scores stay DURANT.
- Players page GP column: games played in the chosen range (sortable). Gms column: each row's games left / total in the league's current matchup week, the same count and
  colors as My team's chip (`getWeekGames` in `queries/weekGames.ts`, run for the page's rows only; not sortable).
- Players page filters: a name search (`q`) ignores them all and looks across every player (`getPlayers`); the filters apply only when not searching. A search also lists players with no game in the range (active ones: a game this season or last, on a roster or on the injury report, e.g. hurt since opening night; not `players.team_id`, which retired players keep) after the ranked ones, with no rank, stats or value; without a search they never show. Injured hides players listed Out by default (`?injured=show` in the page URL turns that off; the API's
  `injured=hide` defaults to showing them).
- Players page ranges: season, last 30 and last 14 days (`statWindow` in `queries/players.ts`), or Custom
  (`range=custom&from=&to=`, inclusive dates, picked between the season's first and last played dates); the player modal shows
  his rank in each (`PlayerDetailResponse.ranks`, the signed-in user's punts, by the page's DURANT/9CAT method) and, quieter, his rank by the other method (`otherRanks`).
  Past seasons show his rank each season at `DEFAULT_WEIGHTS` (`pastSeasonRanks`, cached in memory).
  The nine category cells (not Value) are shaded with Box scores' tiers (`tierOf`), placed among the valuation pool's per-game
  z-scores (`Valuation.tiers` in `value.ts`, `PlayerRow.tiers`), so green/red means better/worse than a rostered player.
  In Totals mode the stats are placed among the pool's season totals instead (`totalTiers`; FG%/FT% by total impact),
  so fewer games ranks lower; Value and the # rank switch to the totals valuation too (`totalValue`/`totalRank`).
- NBA trades: `players.team_id` is only the current team; each stat line keeps the team he played for. Anything that
  finds a player's game on a past date uses `player_team_on(player, date)` (migration 0020), not `players.team_id`.
- The "today" pages show (Box scores, Matchup, My team and team lineups: default day, "Today" labels) is the Pacific
  date (`GAME_DAY_TZ` / `gameDayToday` in `src/lib/gameDay.ts`), so a night stays today until West Coast games end.
  Display only: lineup locks (`TeamLineupResponse.lockedBefore`) and waivers use the league's date.
- `src/lib/queries/boxScores.ts` + `/box-scores`: every game's box score for a date (`?date=`). Each line's Value is one
  game scored against the season's pool (`gameScorer` in `value.ts`, your punt weights); `rankDay` (pure, tested) ranks
  every stat against all players who played that date, and the cells are shaded by that tier. Every game stays listed:
  clicking one in the scoreboard scrolls to it, and once the scoreboard scrolls off a compact copy pins to the top
  (`--sticky-head-top` drops the tables' pinned headers below it).
- Yahoo is the league's source of truth (README, "Mirroring the league from Yahoo (API)"): the league plays on Yahoo
  and the worker's `yahoo` task mirrors it read-only through the Yahoo Fantasy API (`src/lib/yahoo/sync.ts`: rosters
  + transactions every `YAHOO_REFRESH_MINUTES` (5), this week's scoreboard hourly, settings/standings/every week daily
  and when a week ends; `dueScope` pure, tested). The commissioner connects once at `/league/yahoo` (OAuth code flow,
  `oauth.ts`; `/api/yahoo/connect|callback`; a data connection, not a sign-in); `yahoo_connection` (migration 0025)
  keeps the refresh token encrypted (`crypto.ts`, `YAHOO_TOKEN_KEY`), last refresh and last error. `api.ts` calls
  Yahoo (401 refreshes the token, backs off on 999/429 "Request denied"). `GET /api/yahoo/status`, `POST
  /api/yahoo/refresh` (any league member, once a minute per league) and `components/yahoo/YahooRefresh.tsx`
  ("Updated 4 min ago · Refresh", no props; under the League page's title and on My team / team pages, with a
  "Yahoo connection" link, or "Connect Yahoo" before one exists, for the commissioner). `fromApi.ts` (pure, tested on `fixtures/`, written from Yahoo's docs;
  README lists every assumption) builds the `ImportSnapshot` (`parse.ts`); `apply.ts` writes it in place, keyed by
  `fantasy_teams.yahoo_team_key` (first time by name), `yahoo_players` (Yahoo player key -> ours, `matched_by =
  'hand'` to fix one), `transactions.yahoo_key`; a second identical pass changes nothing. `week_results.final`:
  finished weeks true (they replace the computed week in `weekLines` and the Matchup page), the current week's live
  totals false (only power rankings read those). `npm run yahoo:sync` runs a pass by hand (`--fixtures` without a key).
- Yahoo CSV import, the fallback (README, "Importing a league from Yahoo CSVs"): `scripts/yahoo/import.ts` updates the
  season's league in place from a folder of CSVs (`--replace` deletes it first; dry run unless `--apply`) read by
  `src/lib/yahoo/csv.ts` (pure, tested; README has the formats; the `yahoo-csv-refresh` skill builds them from Yahoo's
  pages), through the same `apply.ts`. Player matching is in `parse.ts` (pure, tested).
  `league_members` maps manager emails to teams (Yahoo's API doesn't share them, so only the CSVs set it); sign-in
  links them (`src/lib/auth/members.ts`).
  Yahoo's completed transactions become ordinary `transactions` rows (no `waiver_run_id`), so
  they show in history and count toward add limits; players dropped within the waiver period go back on waivers.
  The CSVs' failed claims (`status` `failed`) become failed claims without a run, shown only in waiver reports.
- Privacy: league data (rosters, owners, waivers, matchups, standings, rankings, trades, transactions, team logos) is
  signed-in only. Signed out, the header shows League (a sign-in prompt), Players and Box scores; Players hides the
  league filters and Owner column, Box scores its Owner column, and the routes strip `owner`/`waiver`/`thisWeek`/
  `transactions`. League-only pages call `requireSignedInPage` (`src/lib/auth/viewer.ts`, redirects to /league). The root
  layout reads the session once (`currentSession`) into `SessionProvider` (`useSignedIn` on the client).
- `src/components/`: UI. `Avatar` must fall back to initials. A team's name (or abbreviation) is a `TeamLink` wherever it
  appears (its page, or /my-team for yours); in a row that links elsewhere (scoreboard pairings, bracket games), that
  row's link is a cover over the row and the names sit above it, never nested links. Wide tables (Players, Box scores) use
  `table/StickyHeadTable` (sideways scroll, header pinned to the page via a measured copy, `data-scrolled` once
  scrolled) and `players/ScrollName` (names shorten to "S. Gilgeous-Alexander" while scrolled); My team's roster sets `data-scrolled` itself and also hides headshots then).
- Live updates: `src/components/live/`. While `live` is true (`queries/live.ts` `gamesInProgress`, on `MatchupWeek`,
  `TeamLineupResponse` and `BoxScoresResponse`: a game the page shows is in progress, i.e. one with a league-rostered player,
  one of that day's roster, or on that date; finals don't count, so no countdown or polling once they're all over), Matchup and Box scores (`LiveRefresh`, `router.refresh`) and My team
  (refetch) poll every minute (`LIVE_POLL_MS`), each with a countdown to the next update (`LiveCountdown`, from `useLivePoll`'s `nextAt`;
  `pin` floats a copy at the top of the screen once it scrolls off; Box scores shows a compact one in its pinned bar
  instead, `useLiveRefresh`). `Flash` highlights a value that changed (not on first render, from null, or when its
  `scope`, e.g. the player in the row, changed); its `delta` adds a badge with the change (`countDelta`: "+1", red when
  TO goes up; `shotsDelta`: "+2/3", green/red/grey by what it did to the percentage; a rank's "▲3"). All three pages
  flash stats, totals and game statuses and badge counting and shooting stats; Box scores also badges the rank (only
  when the player's own Value changed) and `useFlipRows` slides its re-sorted rows into place (rising rows pass over the
  others). Matchup and My team rows stay in slot order.
- `docs/design/*.mockup.html`: the design mockups to match, copied from the design canvas (https://claude.ai/artifact/3ZpzKr2ULidGFpMvgVcvAm, private to the owner).
  `players-table` and `player-modal` are the Players page;
  `league-settings` is /league/settings (built read-only, no save bar); `my-team`, `matchup`, `league`, `rankings`, `nav-map` and
  `my-team-phone` follow the built pages, minus their edit controls; `claim-player`, `trade-builder`, `trade-analyzer` and
  `edit-team` are for features removed when the league moved back to Yahoo. Not built yet: `sign-in-flow`, `sign-in`, `welcome`, `not-in-league`
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
- Before pushing: `npm run typecheck` and `npm run build` pass. `.githooks/pre-push` (enable once per clone: `git config core.hooksPath .githooks`) runs the import check, tests and typecheck on the commit being pushed. `npm run build` runs `prebuild` first, on Railway too, so a failure stops the deploy: `scripts/check-client-imports.ts` (server code can't call a function from a `"use client"` module; it passes typecheck and `next build`, then throws at render) and `npm test` (every `*.test.ts`).

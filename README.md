# fantasy-hoops

## Data

All provider access goes through `src/lib/bdl/` (BALLDONTLIE). Configure `.env` from `.env.example`
(`BALLDONTLIE_API_KEY`, `BALLDONTLIE_RPM`, `DATABASE_URL`). The client spaces requests to stay under
`BALLDONTLIE_RPM` and retries 429/5xx with backoff.

```sh
npm run db:migrate                          # apply db/schema.sql (idempotent)
npm run sync:players                        # 30 current teams + all players (~60 requests)
npm run backfill -- --seasons 2026,2025     # games + stat lines per season (~300+ requests/season)
npm run backfill -- --seasons 2024,2023
```

- `backfill` is resumable: each page is committed together with its cursor in `sync_state`, so an
  interrupted run continues where it stopped. Completed seasons whose games are all final are skipped;
  an in-progress season gets an incremental pass (from 2 days before the last run). Options:
  `--since YYYY-MM-DD` (only games on/after a date), `--force` (redo a season), `--skip-games`.
- Postseason rows are stored with `postseason = true`. For season averages filter on
  `player_game_stats.regular_season` (or `games.game_type = 'regular'`), not `NOT postseason`: the API
  marks play-in games and the NBA Cup Championship `postseason = false`, but they aren't regular season.
  `min` is stored as decimal minutes; rows with `min = 0` are DNPs (or not-yet-checked-in during a
  live game) and don't count as games played.
- `npm run fetch:samples` re-fetches the raw responses in `data/samples/` (see its README).

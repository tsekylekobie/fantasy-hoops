# BALLDONTLIE sample responses

Fetched 2026-10-24 with the ALL-STAR key. Files are raw API responses.

| File | Request |
|---|---|
| `teams.json` | `GET /teams` |
| `players.json` | `GET /players?per_page=25` |
| `games-2026-10-23.json` | `GET /games?dates[]=2026-10-23&per_page=100` |
| `stats-2026-10-23.json` | `GET /stats?dates[]=2026-10-23&per_page=100` (first page only) |
| `player_injuries.json` | `GET /player_injuries?per_page=100` (first page only) |

## Findings (PLAN.md open questions)

- **Base URL and auth (Q4):** `https://api.balldontlie.io/v1` with `Authorization: <key>` (no `Bearer`) works. Tier-restricted endpoints return `401` with body `Unauthorized`.
- **Pagination:** cursor-based. Responses carry `meta.next_cursor`; pass it back as `cursor=`. No `next_cursor` means the last page. `/teams` has no `meta`.
- **DNPs (Q1):** yes, `/stats` returns rows for players who did not play, with `min: "0"` and zero counting stats (14 of 100 rows here). Don't count them as games played. Whether rows exist before a player enters a live game is still unknown (all sample games were final).
- **Live update speed (Q2):** still unknown; needs a capture during a live game.
- **Field shapes (Q3):**
  - `/stats` `min` is a **string**: `"MM:SS"` (e.g. `"35:22"`) or `"0"`. Parse to decimal minutes.
  - `fg_pct`, `fg3_pct`, `ft_pct` can be `null` (0 attempts). Ignore them anyway: compute from makes/attempts.
  - `/stats` rows also have `plus_minus`. Nested `player` has `team_id` (not a `team` object); nested `team` is the team the player played for in that game; nested `game` has `home_team_id`/`visitor_team_id` and `season`.
  - `/games` has `status` (`"Final"`), `status_state` (`"final"`), `datetime`, `postponed`, quarter scores, and nested `home_team`/`visitor_team` objects.
  - `/teams` returns **89** teams, including defunct franchises. Only ids 1–30 have a conference and division; those are the current NBA teams.
  - `/players` positions seen: `G`, `F`, `C`, `G-F`, `C-F` (not `PG`/`SG`). Nested `team` object. **No headshot or NBA person id field.**
- **Injuries:** `status` is one of `Available`, `Day-To-Day`, `Doubtful`, `Out`, `Probable`, `Questionable` (more than PLAN.md assumed). `return_date` is a **full ISO date** (`"2026-10-28"`), not a yearless string. `description` is free text. Rows have no id or timestamp, so snapshots need our own `fetched_at`.

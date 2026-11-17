-- NBA data from ESPN (src/lib/espn). Our ids stay BALLDONTLIE's: league history,
-- rosters and watchlists all key on them. espn_id links each row to ESPN's id;
-- scripts/espn/match-ids.ts fills it for rows we already have.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS espn_id integer UNIQUE;
ALTER TABLE players ADD COLUMN IF NOT EXISTS espn_id integer UNIQUE;
ALTER TABLE games ADD COLUMN IF NOT EXISTS espn_id integer UNIQUE;

-- Ids for players and games ESPN has and we don't. BALLDONTLIE's player ids
-- reach about 1.1 billion and its game ids about 22 million, so new ones start
-- at 2 billion (or above anything already stored), well clear of both and
-- still inside integer.
CREATE SEQUENCE IF NOT EXISTS players_new_id_seq AS integer START 2000000000;
CREATE SEQUENCE IF NOT EXISTS games_new_id_seq AS integer START 2000000000;
SELECT setval('players_new_id_seq', greatest(2000000000, (SELECT coalesce(max(id), 0) + 1 FROM players)), false);
SELECT setval('games_new_id_seq', greatest(2000000000, (SELECT coalesce(max(id), 0) + 1 FROM games)), false);

-- ESPN has no stat-line id; lines are keyed on (player_id, game_id) anyway.
CREATE SEQUENCE IF NOT EXISTS player_game_stats_id_seq AS integer START 2000000000;
SELECT setval('player_game_stats_id_seq', greatest(2000000000, (SELECT coalesce(max(id), 0) + 1 FROM player_game_stats)), false);
ALTER TABLE player_game_stats ALTER COLUMN id SET DEFAULT nextval('player_game_stats_id_seq');

-- ESPN reports the injury itself ("Right Hip Inflammation") apart from the news
-- blurb (description). BALLDONTLIE rows leave it NULL and the injury is parsed
-- out of description (src/lib/queries/injuries.ts).
ALTER TABLE player_injuries ADD COLUMN IF NOT EXISTS injury text;

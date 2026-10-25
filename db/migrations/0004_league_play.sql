-- League play, modelled on Yahoo head-to-head categories: league settings,
-- injuries, daily lineups, weeks and matchups, waivers, transactions, trades.
-- Settings are data on the league so they can change without a deploy.

-- Lineup slot names, shared by roster_players and lineup_slots.
-- IL+ is Yahoo's looser injured slot (e.g. Day-To-Day players).
CREATE DOMAIN lineup_slot AS text
  CHECK (VALUE IN ('PG','SG','G','SF','PF','F','C','UTIL','BN','IL','IL+'));
ALTER TABLE roster_players DROP CONSTRAINT roster_players_slot_check;
ALTER TABLE roster_players ALTER COLUMN slot TYPE lineup_slot;

-- League settings (Yahoo: Commissioner > Edit League Settings).
ALTER TABLE leagues
  ADD COLUMN commissioner_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN max_teams integer NOT NULL DEFAULT 12,
  -- Scored categories, in display order. TO is lower-is-better.
  ADD COLUMN stat_categories text[] NOT NULL
    DEFAULT '{FG_PCT,FT_PCT,FG3M,PTS,REB,AST,STL,BLK,TO}',
  -- Count of each slot; slots with 0 are omitted. BN, IL, IL+ don't score.
  ADD COLUMN roster_slots jsonb NOT NULL
    DEFAULT '{"PG":1,"SG":1,"G":1,"SF":1,"PF":1,"F":1,"C":2,"UTIL":2,"BN":3,"IL":2}',
  -- Daily lineups. 'game_time': each player locks at his game's tip-off.
  -- 'first_game': the whole lineup locks at the day's first tip-off.
  ADD COLUMN lineup_lock text NOT NULL DEFAULT 'game_time'
    CHECK (lineup_lock IN ('game_time', 'first_game')),
  -- Injury statuses (player_injuries.status) that may use each IL slot.
  ADD COLUMN il_statuses text[] NOT NULL DEFAULT '{Out}',
  ADD COLUMN il_plus_statuses text[] NOT NULL DEFAULT '{Out,Doubtful,Questionable,Day-To-Day}',
  -- Acquisitions = adds from free agents or waivers (trades don't count).
  -- Weeks are matchup weeks. NULL = unlimited.
  ADD COLUMN max_adds_per_week integer DEFAULT 4,
  ADD COLUMN max_adds_per_season integer,
  -- 'continual_rolling': a successful claim sends you to the back of the order.
  -- 'reverse_standings': order resets each week, worst record first.
  -- 'faab': blind bids from a season budget; priority breaks ties.
  ADD COLUMN waiver_type text NOT NULL DEFAULT 'continual_rolling'
    CHECK (waiver_type IN ('continual_rolling', 'reverse_standings', 'faab')),
  ADD COLUMN faab_budget integer NOT NULL DEFAULT 100,
  -- Claims are processed daily at this local time.
  ADD COLUMN waiver_time time NOT NULL DEFAULT '03:00',
  ADD COLUMN time_zone text NOT NULL DEFAULT 'America/New_York',
  -- Days a dropped player stays on waivers (cleared at the next waiver run after).
  ADD COLUMN waiver_days integer NOT NULL DEFAULT 2,
  -- Yahoo's "free agents become waivers once their game starts" option.
  ADD COLUMN waivers_after_game_start boolean NOT NULL DEFAULT false,
  ADD COLUMN trade_review text NOT NULL DEFAULT 'commissioner'
    CHECK (trade_review IN ('none', 'commissioner', 'league_vote')),
  ADD COLUMN trade_review_days integer NOT NULL DEFAULT 2,
  ADD COLUMN trade_veto_votes integer NOT NULL DEFAULT 4,  -- league_vote only
  ADD COLUMN trade_deadline date,
  ADD COLUMN playoff_teams integer NOT NULL DEFAULT 6,
  -- First playoff week (league_weeks.week). Byes go to the top seeds.
  ADD COLUMN playoff_start_week integer,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE fantasy_teams
  ADD COLUMN faab_balance integer;  -- NULL unless waiver_type = 'faab'

-- Injury report history from /player_injuries. A row is written only when a
-- player's report changes; a row with status NULL means he left the report.
-- The latest row per player is his current status.
CREATE TABLE player_injuries (
  id          bigserial PRIMARY KEY,
  player_id   integer NOT NULL REFERENCES players(id),
  status      text,                          -- 'Out', 'Day-To-Day', 'Questionable', ...
  return_date date,
  description text,
  raw         jsonb,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX player_injuries_player_idx ON player_injuries (player_id, observed_at DESC);

-- Matchup weeks (Yahoo: Mon-Sun; week 1 starts on opening night).
CREATE TABLE league_weeks (
  league_id   bigint NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  week        integer NOT NULL,
  starts_on   date NOT NULL,
  ends_on     date NOT NULL,
  is_playoffs boolean NOT NULL DEFAULT false,
  PRIMARY KEY (league_id, week),
  CHECK (ends_on >= starts_on)
);

-- Head-to-head pairings. team_b_id NULL is a playoff bye. Regular-season
-- weeks are scheduled up front; playoff rounds are added as seeds are known.
CREATE TABLE matchups (
  id         bigserial PRIMARY KEY,
  league_id  bigint NOT NULL,
  week       integer NOT NULL,
  team_a_id  bigint NOT NULL,
  team_b_id  bigint,
  status     text NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'live', 'final')),
  -- Category wins for each side and ties, filled in as the week is scored.
  team_a_wins integer NOT NULL DEFAULT 0,
  team_b_wins integer NOT NULL DEFAULT 0,
  ties        integer NOT NULL DEFAULT 0,
  -- Category totals per side, e.g. {"a": {"PTS": 512, ...}, "b": {...}}.
  stats       jsonb,
  FOREIGN KEY (league_id, week) REFERENCES league_weeks (league_id, week) ON DELETE CASCADE,
  FOREIGN KEY (league_id, team_a_id) REFERENCES fantasy_teams (league_id, id) ON DELETE CASCADE,
  FOREIGN KEY (league_id, team_b_id) REFERENCES fantasy_teams (league_id, id) ON DELETE CASCADE,
  CHECK (team_a_id <> team_b_id)
);
CREATE INDEX matchups_week_idx ON matchups (league_id, week);

-- The lineup each team used on each day: the record matchups are scored from.
-- roster_players.slot is the standing lineup; a day's rows are written from
-- it (and any edits for that day) and each row freezes once it locks.
-- Rows for future days are edits the manager made ahead of time.
CREATE TABLE lineup_slots (
  league_id       bigint NOT NULL,
  fantasy_team_id bigint NOT NULL,
  date            date NOT NULL,
  player_id       integer NOT NULL REFERENCES players(id),
  slot            lineup_slot NOT NULL,
  locked_at       timestamptz,               -- set at tip-off (or the day's first tip)
  PRIMARY KEY (fantasy_team_id, date, player_id),
  FOREIGN KEY (league_id, fantasy_team_id) REFERENCES fantasy_teams (league_id, id) ON DELETE CASCADE
);
CREATE INDEX lineup_slots_date_idx ON lineup_slots (league_id, date);

-- Players on waivers: dropped players until clears_at, then free agents again.
CREATE TABLE waiver_players (
  league_id          bigint NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  player_id          integer NOT NULL REFERENCES players(id),
  clears_at          timestamptz NOT NULL,
  dropped_by_team_id bigint REFERENCES fantasy_teams(id) ON DELETE SET NULL,
  PRIMARY KEY (league_id, player_id)
);

-- Every roster move, pending or done: free-agent adds, waiver claims, drops,
-- trades and commissioner moves. The players moved are in transaction_players.
--   status: pending   = waiver claim awaiting the run, or trade awaiting a reply/review
--           completed = rosters changed
--           failed    = claim lost or became invalid (see failure_reason)
--           rejected  = trade declined by the other manager
--           vetoed    = trade vetoed by the commissioner or league vote
--           cancelled = withdrawn by the proposer
CREATE TABLE transactions (
  id             bigserial PRIMARY KEY,
  league_id      bigint NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  type           text NOT NULL CHECK (type IN ('add', 'drop', 'add_drop', 'waiver_claim', 'trade', 'commissioner')),
  status         text NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'rejected', 'vetoed', 'cancelled')),
  team_id        bigint REFERENCES fantasy_teams(id) ON DELETE CASCADE,  -- who made the move
  trade_team_id  bigint REFERENCES fantasy_teams(id) ON DELETE CASCADE,  -- trade partner
  created_by     bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Waiver claims: when they process, the team's own preference order, FAAB bid.
  process_at     timestamptz,
  claim_rank     integer,
  faab_bid       integer,
  -- Trades: when the other manager accepted (review starts), and the message.
  accepted_at    timestamptz,
  note           text,
  processed_at   timestamptz,
  failure_reason text
);
CREATE INDEX transactions_league_idx ON transactions (league_id, created_at DESC);
CREATE INDEX transactions_pending_idx ON transactions (league_id, process_at) WHERE status = 'pending';

-- Players moved by a transaction. from_team_id NULL = came from free agents
-- or waivers; to_team_id NULL = dropped.
CREATE TABLE transaction_players (
  transaction_id bigint NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  player_id      integer NOT NULL REFERENCES players(id),
  from_team_id   bigint REFERENCES fantasy_teams(id) ON DELETE CASCADE,
  to_team_id     bigint REFERENCES fantasy_teams(id) ON DELETE CASCADE,
  PRIMARY KEY (transaction_id, player_id),
  CHECK (from_team_id IS NOT NULL OR to_team_id IS NOT NULL)
);
CREATE INDEX transaction_players_player_idx ON transaction_players (player_id);

-- League-vote trade review: one veto vote per team.
CREATE TABLE trade_votes (
  transaction_id bigint NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  team_id        bigint NOT NULL REFERENCES fantasy_teams(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transaction_id, team_id)
);

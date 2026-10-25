-- Sign-in (Google OAuth). google_sub is Google's stable account id; mock
-- sign-ins in local dev use 'mock:<email>' so they never collide with real ones.
CREATE TABLE IF NOT EXISTS users (
  id           bigserial PRIMARY KEY,
  google_sub   text NOT NULL UNIQUE,
  email        text NOT NULL,
  name         text NOT NULL,
  picture_url  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- One row per signed-in device. The cookie holds a random token; only its
-- SHA-256 is stored, so a leaked table can't be replayed as cookies.
-- expires_at slides forward while the device keeps using the app.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   bytea PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

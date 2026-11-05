-- Sign-in with more than one provider (Google, Yahoo). Each provider account a
-- user signs in with is one row here, so one user can have both. users.google_sub
-- (migration 0002) moves here: Google's sub as provider 'google', and mock
-- sign-ins ('mock:<email>') as provider 'mock' with the email as the subject.
--
-- email / email_verified are what the provider last said. A new provider account
-- joins an existing user only through a verified email that another of that
-- user's accounts also verified (src/lib/auth/session.ts, signInUser), and only
-- a verified email links league teams (league_members).
CREATE TABLE IF NOT EXISTS user_identities (
  provider       text NOT NULL CHECK (provider IN ('google', 'yahoo', 'mock')),
  subject        text NOT NULL,
  user_id        bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email          text NOT NULL,
  email_verified boolean NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS user_identities_user_idx ON user_identities (user_id);
CREATE INDEX IF NOT EXISTS user_identities_email_idx ON user_identities (lower(email)) WHERE email_verified;

-- Google only ever signed in verified emails (src/lib/auth/google.ts refused the rest).
INSERT INTO user_identities (provider, subject, user_id, email, email_verified, created_at, last_used_at)
SELECT CASE WHEN google_sub LIKE 'mock:%' THEN 'mock' ELSE 'google' END,
       CASE WHEN google_sub LIKE 'mock:%' THEN substr(google_sub, 6) ELSE google_sub END,
       id, email, true, created_at, last_seen_at
  FROM users
ON CONFLICT DO NOTHING;

ALTER TABLE users DROP COLUMN google_sub;

-- Web Push: one row per browser or device a user turned injury alerts on in
-- (src/lib/push/send.ts). The worker's injuries task notifies the owners of
-- rostered players whose injury status got worse. endpoint is the push
-- service URL for that browser; p256dh / auth are its encryption keys.
-- A subscription the push service reports gone (404/410) is deleted.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint    text PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);

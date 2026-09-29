-- Browser push notification subscriptions (Web Push API).
--
-- Keyed by `endpoint` (unique per browser+device+origin), not by user —
-- that's what makes "allow notifications" survive logout/login and even a
-- different account logging into the same browser: the subscribe endpoint
-- always upserts by endpoint and rebinds user_id to whoever's currently
-- logged in, rather than creating a duplicate or requiring the browser
-- permission prompt again. The browser-level permission grant and the
-- service worker's subscription are independent of this app's login
-- state entirely — nothing here should ever call pushManager.unsubscribe()
-- on logout, or the same problem just resurfaces client-side.
CREATE TABLE push_subscriptions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);

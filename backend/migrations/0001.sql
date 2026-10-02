PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS protected_values (
  key TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY, google_location_id TEXT NOT NULL UNIQUE,
  google_account_id TEXT NOT NULL, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '', metadata TEXT NOT NULL DEFAULT '{}',
  auto_reply INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_sync INTEGER,
  next_sync INTEGER NOT NULL DEFAULT 0, sync_run TEXT, sync_heartbeat INTEGER, sync_error TEXT,
  review_count INTEGER NOT NULL DEFAULT 0, average_rating REAL NOT NULL DEFAULT 0,
  voice_status TEXT NOT NULL DEFAULT 'pending', voice_profile TEXT,
  voice_sources TEXT NOT NULL DEFAULT '{}', voice_error TEXT,
  billing_enabled INTEGER NOT NULL DEFAULT 0, trial_enabled INTEGER NOT NULL DEFAULT 0,
  subscription_enabled INTEGER NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'active' CHECK(payment_status IN ('trial','active','expired','cancelled')),
  payment_method TEXT NOT NULL DEFAULT 'transfer' CHECK(payment_method IN ('cash','transfer','stripe','paypal')),
  cycle TEXT NOT NULL DEFAULT 'monthly' CHECK(cycle IN ('monthly','yearly','custom')),
  amount REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'NGN',
  custom_days INTEGER NOT NULL DEFAULT 30, trial_ends_at INTEGER, next_due_at INTEGER,
  backfill_limit INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id),
  google_review_id TEXT NOT NULL, reviewer TEXT NOT NULL DEFAULT 'Google customer',
  rating INTEGER NOT NULL, comment TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, detected_at INTEGER NOT NULL,
  reply TEXT, replied_at INTEGER, reply_source TEXT,
  reply_state TEXT NOT NULL DEFAULT 'unreplied', had_reply INTEGER NOT NULL DEFAULT 0,
  historical INTEGER NOT NULL DEFAULT 1, eligible_at INTEGER, seen_run TEXT,
  archived INTEGER NOT NULL DEFAULT 0, write_owner TEXT, write_lease_until INTEGER, UNIQUE(business_id,google_review_id)
);
CREATE INDEX IF NOT EXISTS reviews_business ON reviews(business_id,archived,created_at);
CREATE INDEX IF NOT EXISTS reviews_ready ON reviews(reply_state,eligible_at);
CREATE TABLE IF NOT EXISTS ai_keys (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, ciphertext TEXT NOT NULL,
  suffix TEXT NOT NULL, model TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  health TEXT NOT NULL DEFAULT 'active', cooldown_until INTEGER, error TEXT,
  request_count INTEGER NOT NULL DEFAULT 0, last_used INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO counters(key,value) VALUES ('ai_rotation',0);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  entity_id TEXT, payload TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'pending',
  available_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER, last_dispatched INTEGER, error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(state,available_at,lease_until);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, href TEXT NOT NULL DEFAULT 'dashboard.html',
  business_id TEXT, created_at INTEGER NOT NULL, read_at INTEGER,
  visible INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS notification_inbox ON notifications(visible,created_at);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY, notification_id TEXT NOT NULL REFERENCES notifications(id),
  channel TEXT NOT NULL, destination TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT, error TEXT, sent_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY, endpoint_hash TEXT NOT NULL UNIQUE, ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_used INTEGER
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id),
  amount REAL NOT NULL, currency TEXT NOT NULL, method TEXT NOT NULL,
  paid_at INTEGER NOT NULL, due_at INTEGER, note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY, business_id TEXT, action TEXT NOT NULL,
  level TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_date ON logs(created_at);
CREATE TABLE IF NOT EXISTS auth_attempts (
  identity TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL
);

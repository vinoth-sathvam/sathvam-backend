-- Admin Audit Log — tracks all mutating API calls made by authenticated admin users
-- Run in Supabase Dashboard > SQL Editor

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id        BIGSERIAL PRIMARY KEY,
  ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id   TEXT,
  username  TEXT,
  role      TEXT,
  method    TEXT,
  path      TEXT,
  status    INTEGER,
  ip        TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_ts       ON admin_audit_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id  ON admin_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_method   ON admin_audit_logs(method);

-- Optional: auto-delete entries older than 90 days to keep table lean
-- (run manually or schedule via pg_cron if needed)
-- DELETE FROM admin_audit_logs WHERE ts < now() - interval '90 days';

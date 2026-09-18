-- Migration 038: Persistent checkout recovery log for reporting
-- Stores every checkout session outcome permanently (the settings JSON blob only keeps 48h)

CREATE TABLE IF NOT EXISTS checkout_recovery_log (
  id              BIGSERIAL PRIMARY KEY,
  session_id      TEXT NOT NULL,
  phone           TEXT NOT NULL,
  name            TEXT,
  email           TEXT,
  city            TEXT,
  referrer        TEXT,
  cart_items      INTEGER DEFAULT 0,
  cart_total      NUMERIC DEFAULT 0,
  is_returning    BOOLEAN DEFAULT false,
  started_at      TIMESTAMPTZ NOT NULL,
  wa_sent         BOOLEAN DEFAULT false,
  wa_sent_at      TIMESTAMPTZ,
  wa_ok           BOOLEAN,
  completed       BOOLEAN DEFAULT false,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Prevent duplicate logs for the same session
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_recovery_log_session
  ON checkout_recovery_log(session_id);

-- Fast date-range queries for reports
CREATE INDEX IF NOT EXISTS idx_checkout_recovery_log_started
  ON checkout_recovery_log(started_at DESC);

-- Fast filter on wa_sent + completed for funnel stats
CREATE INDEX IF NOT EXISTS idx_checkout_recovery_log_funnel
  ON checkout_recovery_log(wa_sent, completed);

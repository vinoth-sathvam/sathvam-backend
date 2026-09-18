-- Migration 040: Unified follow-up log for re-engagement + delivery review requests
-- Stores every outbound follow-up send for permanent reporting

CREATE TABLE IF NOT EXISTS customer_followup_log (
  id              BIGSERIAL PRIMARY KEY,
  type            TEXT NOT NULL,        -- 're_engagement' | 'review_request'
  phone           TEXT NOT NULL,
  name            TEXT,
  segment         TEXT,                 -- 'at_risk' | 'lapsing' | 'churned' (for re-engagement)
  order_no        TEXT,                 -- order ref (for review requests)
  days_since      INTEGER,             -- days since last order / delivery
  status          TEXT NOT NULL,        -- 'sent' | 'failed' | 'skipped'
  ai_personalized BOOLEAN DEFAULT false,
  sent_at         TIMESTAMPTZ DEFAULT now(),
  run_id          TEXT                  -- groups sends from same run
);

CREATE INDEX IF NOT EXISTS idx_followup_log_type ON customer_followup_log(type);
CREATE INDEX IF NOT EXISTS idx_followup_log_sent ON customer_followup_log(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_followup_log_type_sent ON customer_followup_log(type, sent_at DESC);

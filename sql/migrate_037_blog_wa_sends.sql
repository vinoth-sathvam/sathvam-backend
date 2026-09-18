-- Migration 037: Blog WhatsApp Send Tracking
-- Tracks which blog post was sent to which customer via WhatsApp
-- Run in PostgreSQL (Supabase SQL Editor or psql)

CREATE TABLE IF NOT EXISTS blog_wa_sends (
  id            BIGSERIAL PRIMARY KEY,
  blog_id       UUID NOT NULL,
  blog_title    TEXT NOT NULL,
  blog_lang     TEXT DEFAULT 'en',          -- 'en' or 'ta'
  customer_id   UUID,                        -- NULL for non-logged-in customers from orders
  customer_phone TEXT NOT NULL,              -- normalized phone (91XXXXXXXXXX)
  customer_name  TEXT,
  status        TEXT NOT NULL DEFAULT 'sent', -- 'sent' | 'failed'
  error_msg     TEXT,
  sent_at       TIMESTAMPTZ DEFAULT now(),
  run_id        TEXT                         -- groups sends from same script run
);

CREATE INDEX IF NOT EXISTS idx_blog_wa_sends_blog_id ON blog_wa_sends(blog_id);
CREATE INDEX IF NOT EXISTS idx_blog_wa_sends_phone   ON blog_wa_sends(customer_phone);
CREATE INDEX IF NOT EXISTS idx_blog_wa_sends_sent_at ON blog_wa_sends(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_wa_sends_run_id  ON blog_wa_sends(run_id);
-- Prevent duplicate: same blog to same phone
CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_wa_sends_uniq ON blog_wa_sends(blog_id, customer_phone);

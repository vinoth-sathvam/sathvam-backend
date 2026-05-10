-- Migration 024: Physical Stock Count Sessions
-- Run in Supabase Dashboard > SQL Editor

CREATE TABLE IF NOT EXISTS stock_count_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  count_date  DATE NOT NULL,
  status      TEXT DEFAULT 'open',     -- 'open' | 'closed' | 'applied'
  notes       TEXT,
  created_by  TEXT,
  closed_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_count_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID REFERENCES stock_count_sessions(id) ON DELETE CASCADE,
  product_name TEXT NOT NULL,
  unit         TEXT DEFAULT 'pcs',
  system_qty   NUMERIC DEFAULT 0,
  counted_qty  NUMERIC DEFAULT NULL,   -- NULL = not yet counted
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_count_items_session ON stock_count_items(session_id);

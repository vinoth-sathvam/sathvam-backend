-- Migration 021: Delivery runs tables for local delivery management
-- Run in Supabase Dashboard > SQL Editor

CREATE TABLE IF NOT EXISTS delivery_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_date   DATE NOT NULL,
  driver_name     TEXT,
  driver_phone    TEXT,
  vehicle_number  TEXT,
  status          TEXT DEFAULT 'pending',  -- 'pending' | 'in_transit' | 'completed' | 'partial'
  total_orders    INTEGER DEFAULT 0,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS delivery_run_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID REFERENCES delivery_runs(id) ON DELETE CASCADE,
  order_id        UUID REFERENCES webstore_orders(id) ON DELETE SET NULL,
  order_number    TEXT,
  customer_name   TEXT,
  customer_phone  TEXT,
  customer_address TEXT,
  sequence        INTEGER DEFAULT 1,
  status          TEXT DEFAULT 'pending',  -- 'pending' | 'delivered' | 'failed' | 'rescheduled'
  notes           TEXT,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_runs_date         ON delivery_runs(delivery_date DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_run_items_run_id  ON delivery_run_items(run_id);
CREATE INDEX IF NOT EXISTS idx_delivery_run_items_order   ON delivery_run_items(order_id);

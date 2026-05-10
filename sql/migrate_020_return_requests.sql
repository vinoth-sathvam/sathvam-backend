-- Migration 020: Return requests table
-- Run in Supabase Dashboard > SQL Editor

CREATE TABLE IF NOT EXISTS return_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID REFERENCES webstore_orders(id) ON DELETE SET NULL,
  order_number    TEXT NOT NULL,
  customer_name   TEXT,
  customer_phone  TEXT,
  items           JSONB DEFAULT '[]',
  reason          TEXT NOT NULL,
  refund_amount   NUMERIC DEFAULT 0,
  refund_method   TEXT DEFAULT 'original',  -- 'original' | 'bank' | 'store_credit'
  status          TEXT DEFAULT 'pending',   -- 'pending' | 'approved' | 'picked_up' | 'received' | 'refunded' | 'rejected'
  notes           TEXT,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_return_requests_order_id   ON return_requests(order_id);
CREATE INDEX IF NOT EXISTS idx_return_requests_status     ON return_requests(status);
CREATE INDEX IF NOT EXISTS idx_return_requests_created_at ON return_requests(created_at DESC);

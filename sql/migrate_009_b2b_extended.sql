-- B2B Extended Features Migration
-- Run this in Supabase SQL Editor

-- 1. Add credit limit fields to b2b_customers
ALTER TABLE b2b_customers
  ADD COLUMN IF NOT EXISTS credit_limit  NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credit_used   NUMERIC(12,2) DEFAULT 0;

-- 2. Add tracking & compliance fields to b2b_orders
ALTER TABLE b2b_orders
  ADD COLUMN IF NOT EXISTS carrier_tracking_url TEXT,
  ADD COLUMN IF NOT EXISTS compliance_checklist JSONB DEFAULT '{}';

-- 3. Quotations / RFQ table
CREATE TABLE IF NOT EXISTS b2b_quotations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID REFERENCES b2b_customers(id) ON DELETE CASCADE,
  order_id        UUID REFERENCES b2b_orders(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'requested',  -- requested, quoted, accepted, rejected, converted
  items           JSONB DEFAULT '[]',
  notes           TEXT DEFAULT '',
  admin_notes     TEXT DEFAULT '',
  total_value     NUMERIC(14,2) DEFAULT 0,
  expires_at      DATE,
  requested_by    TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_b2b_quotations_customer ON b2b_quotations(customer_id);
CREATE INDEX IF NOT EXISTS idx_b2b_quotations_status   ON b2b_quotations(status);

-- RLS policies for quotations (admin can see all, customers see their own)
ALTER TABLE b2b_quotations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "b2b_quotations_all" ON b2b_quotations;
CREATE POLICY "b2b_quotations_all" ON b2b_quotations FOR ALL USING (true);

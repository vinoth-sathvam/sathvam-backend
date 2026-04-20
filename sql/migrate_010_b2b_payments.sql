-- B2B Payment Tracking
-- Run this in Supabase SQL Editor

ALTER TABLE b2b_orders
  ADD COLUMN IF NOT EXISTS advance_paid     NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS advance_date     DATE,
  ADD COLUMN IF NOT EXISTS advance_ref      TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS advance_notes    TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS remaining_paid   NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS remaining_date   DATE,
  ADD COLUMN IF NOT EXISTS remaining_ref    TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS remaining_notes  TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS payment_status   TEXT DEFAULT 'unpaid';
  -- payment_status: unpaid | advance_paid | fully_paid

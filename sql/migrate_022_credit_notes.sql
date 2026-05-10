-- Migration 022: Credit Notes
-- Run in Supabase Dashboard > SQL Editor

CREATE TABLE IF NOT EXISTS credit_notes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cn_number       TEXT UNIQUE NOT NULL,           -- e.g. CN-2026-0001
  date            DATE NOT NULL,
  order_ref       TEXT,                           -- original order number (webstore or B2B)
  order_id        UUID,                           -- webstore_orders.id if applicable
  customer_name   TEXT NOT NULL,
  customer_phone  TEXT,
  customer_email  TEXT,
  gstin           TEXT,
  reason          TEXT NOT NULL,                  -- 'return' | 'discount' | 'pricing_error' | 'quality' | 'other'
  items           JSONB DEFAULT '[]',             -- [{name, qty, rate, gst_pct, amount}]
  subtotal        NUMERIC DEFAULT 0,
  gst_amount      NUMERIC DEFAULT 0,
  total           NUMERIC DEFAULT 0,
  status          TEXT DEFAULT 'draft',           -- 'draft' | 'issued' | 'adjusted' | 'void'
  notes           TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS credit_note_seq START 1;

CREATE INDEX IF NOT EXISTS idx_credit_notes_date   ON credit_notes(date DESC);
CREATE INDEX IF NOT EXISTS idx_credit_notes_status ON credit_notes(status);

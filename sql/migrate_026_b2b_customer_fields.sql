-- Add extended fields to b2b_customers
ALTER TABLE b2b_customers
  ADD COLUMN IF NOT EXISTS branch           TEXT,
  ADD COLUMN IF NOT EXISTS gstin            TEXT,
  ADD COLUMN IF NOT EXISTS pan              TEXT,
  ADD COLUMN IF NOT EXISTS gst_treatment    TEXT,
  ADD COLUMN IF NOT EXISTS payment_terms    TEXT,
  ADD COLUMN IF NOT EXISTS delivery_address TEXT;

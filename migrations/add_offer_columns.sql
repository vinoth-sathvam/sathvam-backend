-- Add offer/sale badge columns to products table
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS offer_label    TEXT,
  ADD COLUMN IF NOT EXISTS offer_price    NUMERIC,
  ADD COLUMN IF NOT EXISTS offer_ends_at  DATE;

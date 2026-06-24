-- Migration 030: Add FSSAI license field to products table
-- Run in Supabase Dashboard → SQL Editor

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS fssai_license TEXT DEFAULT NULL;

-- Valid values: 'manufacturer', 'merchant_export', 'both', NULL (not set)
COMMENT ON COLUMN products.fssai_license IS 'FSSAI license type: manufacturer | merchant_export | both | NULL';

-- Migration 018: Add shipped_qty to b2b_order_items
-- Run in Supabase Dashboard > SQL Editor

ALTER TABLE b2b_order_items
  ADD COLUMN IF NOT EXISTS shipped_qty NUMERIC DEFAULT NULL;

COMMENT ON COLUMN b2b_order_items.shipped_qty IS
  'Actual shipped quantity — may differ from ordered qty (qty). NULL means not yet set.';

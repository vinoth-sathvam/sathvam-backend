-- Migration 023: Add pack_size to b2b_order_items
-- Run in Supabase Dashboard > SQL Editor

ALTER TABLE b2b_order_items
  ADD COLUMN IF NOT EXISTS pack_size TEXT DEFAULT NULL;

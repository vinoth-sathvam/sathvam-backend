-- Migration 025b: Add drying stage fields to spice_batches
-- Run in Supabase Dashboard → SQL Editor

ALTER TABLE spice_batches
  ADD COLUMN IF NOT EXISTS total_raw_input_kg NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS after_drying_kg     NUMERIC DEFAULT 0;

-- Migration 025: Spice Powder Batches
-- Tracks multi-ingredient spice powder production (Sambar Powder, Rasam Powder, etc.)
-- Run in Supabase Dashboard → SQL Editor

CREATE TABLE IF NOT EXISTS spice_batches (
  id                     TEXT PRIMARY KEY,
  date                   DATE NOT NULL,
  product_name           TEXT NOT NULL DEFAULT '',
  total_output_kg        NUMERIC DEFAULT 0,
  sent_to_mill_kg        NUMERIC DEFAULT 0,
  grinding_charge_per_kg NUMERIC DEFAULT 0,
  ingredients            JSONB DEFAULT '[]',   -- [{id, name, qty, unit, ratePerKg, fixedCost, amount}]
  total_ingredient_cost  NUMERIC DEFAULT 0,
  total_grinding_charge  NUMERIC DEFAULT 0,
  total_cost             NUMERIC DEFAULT 0,
  cost_per_kg            NUMERIC DEFAULT 0,
  notes                  TEXT DEFAULT '',
  created_by             TEXT DEFAULT '',
  created_at             TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS spice_batches_date_idx ON spice_batches(date DESC);
CREATE INDEX IF NOT EXISTS spice_batches_product_idx ON spice_batches(product_name);

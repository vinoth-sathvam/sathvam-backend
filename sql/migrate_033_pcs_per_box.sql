-- Migration 033: Add pcs_per_box column to products
-- For products sold in boxes (e.g., Agarbathi 12 pcs/box, Bedspread 6 pcs/box)
-- Enables per-piece and per-box cost calculation

ALTER TABLE products ADD COLUMN IF NOT EXISTS pcs_per_box INTEGER DEFAULT NULL;

COMMENT ON COLUMN products.pcs_per_box IS 'Number of pieces/packets per box. NULL = not a boxed product.';

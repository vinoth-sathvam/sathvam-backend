-- Add commodity_id to products table to link finished products to their raw material source
ALTER TABLE products ADD COLUMN IF NOT EXISTS commodity_id TEXT;
-- Index for fast lookup
CREATE INDEX IF NOT EXISTS idx_products_commodity_id ON products(commodity_id);

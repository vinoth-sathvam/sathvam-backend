-- Migration 032: Add compatible_products to packing_materials
-- Maps covers/pouches to the products they can be used for (many-to-many)
-- e.g. "Cover 500 GM" → ["Ragi Flour 500G", "Pearl Millet 500G", "Besan Flour 500G"]

ALTER TABLE packing_materials
  ADD COLUMN IF NOT EXISTS compatible_products JSONB DEFAULT '[]'::jsonb;

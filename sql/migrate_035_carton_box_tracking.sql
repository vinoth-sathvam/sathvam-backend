-- Migration 035: Add carton box tracking to webstore_orders
-- Allows admin to select which carton box was used for each order,
-- tracks cost, and deduction status from packing inventory.

ALTER TABLE webstore_orders ADD COLUMN IF NOT EXISTS carton_box_id TEXT;
ALTER TABLE webstore_orders ADD COLUMN IF NOT EXISTS carton_box_name TEXT;
ALTER TABLE webstore_orders ADD COLUMN IF NOT EXISTS carton_box_cost NUMERIC DEFAULT 0;
ALTER TABLE webstore_orders ADD COLUMN IF NOT EXISTS carton_box_qty INTEGER DEFAULT 0;
ALTER TABLE webstore_orders ADD COLUMN IF NOT EXISTS carton_box_unit_cost NUMERIC DEFAULT 0;
ALTER TABLE webstore_orders ADD COLUMN IF NOT EXISTS carton_box_deducted BOOLEAN DEFAULT false;

-- Migration 036: Add actual courier cost tracking to webstore_orders
-- Stores the real courier charge (what courier company bills us)
-- vs shipping charge (what we charged the customer)

ALTER TABLE webstore_orders ADD COLUMN IF NOT EXISTS actual_courier_cost NUMERIC DEFAULT 0;
ALTER TABLE webstore_orders ADD COLUMN IF NOT EXISTS courier_provider TEXT;

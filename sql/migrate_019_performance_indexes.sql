-- Migration 019: Performance indexes for high-frequency queries
-- Run in Supabase Dashboard > SQL Editor

-- B2B order child tables -- these are JOIN'd on every order list load
CREATE INDEX IF NOT EXISTS idx_b2b_order_items_order_id  ON b2b_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_b2b_order_stages_order_id ON b2b_order_stages(order_id);

-- B2B orders -- customer portal filters by customer_id
CREATE INDEX IF NOT EXISTS idx_b2b_orders_customer_id  ON b2b_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_b2b_orders_created_at   ON b2b_orders(created_at DESC);

-- Settings LIKE query for project_full_* keys
CREATE INDEX IF NOT EXISTS idx_settings_key_pattern ON settings(key text_pattern_ops);

-- High-volume ledger / order tables
CREATE INDEX IF NOT EXISTS idx_stock_ledger_date        ON stock_ledger(date DESC);
CREATE INDEX IF NOT EXISTS idx_procurements_date        ON procurements(date DESC);
CREATE INDEX IF NOT EXISTS idx_webstore_orders_created  ON webstore_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_date               ON sales(date DESC);

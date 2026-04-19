-- Sathvam Performance Indexes
-- Run in: Supabase Dashboard → SQL Editor
-- These indexes speed up the most common queries on hot tables.

-- products: filter by active (every store page load)
CREATE INDEX IF NOT EXISTS idx_products_active
  ON products(active);

-- products: featured + active products for homepage
CREATE INDEX IF NOT EXISTS idx_products_featured
  ON products(featured) WHERE active = true;

-- webstore_orders: filter by status (admin order list)
CREATE INDEX IF NOT EXISTS idx_webstore_orders_status
  ON webstore_orders(status);

-- webstore_orders: sort by date descending (order history)
CREATE INDEX IF NOT EXISTS idx_webstore_orders_created
  ON webstore_orders(created_at DESC);

-- stock_ledger: per-product stock history (stock dashboard)
CREATE INDEX IF NOT EXISTS idx_stock_ledger_product
  ON stock_ledger(product_id, date DESC);

-- abandoned_carts: find stale carts (cart recovery agent)
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_updated
  ON abandoned_carts(updated_at);

-- customers: email hash lookup (every login)
CREATE INDEX IF NOT EXISTS idx_customers_email_hash
  ON customers(email_hash);

-- push_subscriptions: filter by device type (push agent)
CREATE INDEX IF NOT EXISTS idx_push_subs_type
  ON push_subscriptions(device_type);

-- stock_notify: back-in-stock subscriptions
CREATE TABLE IF NOT EXISTS stock_notify (
  id          BIGSERIAL PRIMARY KEY,
  product_id  UUID        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  email       TEXT        NOT NULL,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at TIMESTAMPTZ,
  UNIQUE(product_id, email)
);
CREATE INDEX IF NOT EXISTS idx_stock_notify_product
  ON stock_notify(product_id) WHERE notified_at IS NULL;

-- Migration 041: Add b2b_order_id to procurement, packing, expenses, stock tables
-- Purpose: Enable end-to-end cost tracking per B2B order

-- Link raw material procurements to B2B orders
ALTER TABLE procurements ADD COLUMN IF NOT EXISTS b2b_order_id UUID;
CREATE INDEX IF NOT EXISTS idx_procurements_b2b_order ON procurements(b2b_order_id) WHERE b2b_order_id IS NOT NULL;

-- Link packing material purchases to B2B orders
ALTER TABLE packing_procurement ADD COLUMN IF NOT EXISTS b2b_order_id UUID;
CREATE INDEX IF NOT EXISTS idx_packing_proc_b2b_order ON packing_procurement(b2b_order_id) WHERE b2b_order_id IS NOT NULL;

-- Link general company expenses to B2B orders (optional allocation)
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS b2b_order_id UUID;
CREATE INDEX IF NOT EXISTS idx_company_exp_b2b_order ON company_expenses(b2b_order_id) WHERE b2b_order_id IS NOT NULL;

-- Add order reference to stock_ledger
ALTER TABLE stock_ledger ADD COLUMN IF NOT EXISTS b2b_order_id UUID;
CREATE INDEX IF NOT EXISTS idx_stock_ledger_b2b_order ON stock_ledger(b2b_order_id) WHERE b2b_order_id IS NOT NULL;

-- Add order reference to finished_goods
ALTER TABLE finished_goods ADD COLUMN IF NOT EXISTS b2b_order_id UUID;
CREATE INDEX IF NOT EXISTS idx_finished_goods_b2b_order ON finished_goods(b2b_order_id) WHERE b2b_order_id IS NOT NULL;

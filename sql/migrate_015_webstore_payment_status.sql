-- Migration 015: Ensure payment_status column exists on webstore_orders
-- and backfill confirmed/shipped/delivered orders as 'paid'

ALTER TABLE webstore_orders
  ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT NULL;

-- Backfill: all non-cancelled confirmed/processed orders are paid via Razorpay
UPDATE webstore_orders
SET payment_status = 'paid'
WHERE payment_status IS NULL
  AND status IN ('confirmed', 'packed', 'shipped', 'delivered');

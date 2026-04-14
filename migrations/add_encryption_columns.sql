-- Migration: Add HMAC hash columns for encrypted PII lookups
-- Run this in Supabase Dashboard > SQL Editor BEFORE deploying the encryption code.
--
-- Why hash columns?
--   AES-256-GCM uses a random IV per encryption, so the same email always
--   produces a different ciphertext. That means WHERE email = ? stops working.
--   Instead we store HMAC-SHA256(email) in email_hash and index that.

-- 1. customers: hash column for email lookup
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_customers_email_hash ON customers(email_hash);

-- 2. webstore_orders: hash column so customers can find their own orders
ALTER TABLE webstore_orders ADD COLUMN IF NOT EXISTS customer_email_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_webstore_orders_cust_email_hash ON webstore_orders(customer_email_hash);

-- ── After running this migration ─────────────────────────────────────────────
-- 1. Add ENCRYPTION_KEY to /home/ubuntu/sathvam-backend/.env
--    Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
-- 2. Deploy updated backend code (customer.js, payments.js, webstoreOrders.js)
-- 3. Run the backfill script to encrypt existing rows:
--    node /home/ubuntu/sathvam-backend/scripts/backfill-encryption.js
-- ─────────────────────────────────────────────────────────────────────────────

-- Migration 031: Add date_of_birth to customers table
-- Run in Supabase Dashboard → SQL Editor

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS date_of_birth DATE DEFAULT NULL;

COMMENT ON COLUMN customers.date_of_birth IS 'Customer date of birth — used for birthday WhatsApp offers. Stored as plaintext DATE (not PII-encrypted).';

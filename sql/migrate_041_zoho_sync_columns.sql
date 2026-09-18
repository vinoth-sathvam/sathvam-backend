-- Migration 041: Add Zoho Books sync tracking columns
-- Run in PostgreSQL (Supabase SQL Editor or psql)

-- Vendor bills — track Zoho bill ID
ALTER TABLE vendor_bills ADD COLUMN IF NOT EXISTS zoho_bill_id TEXT;

-- Company expenses — track Zoho expense ID
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS zoho_expense_id TEXT;

-- Purchases/procurement — track Zoho purchase order ID
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS zoho_po_id TEXT;

-- Credit notes — track Zoho credit note ID
ALTER TABLE credit_notes ADD COLUMN IF NOT EXISTS zoho_cn_id TEXT;

-- Bank transactions — Zoho transaction ID for dedup during sync
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS zoho_txn_id TEXT;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_txn_zoho_id ON bank_transactions(zoho_txn_id) WHERE zoho_txn_id IS NOT NULL;

-- Bank accounts — link to Zoho bank account
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS zoho_account_id TEXT;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS zoho_synced_at TIMESTAMPTZ;

-- Sales tables — track Zoho invoice IDs
ALTER TABLE webstore_orders ADD COLUMN IF NOT EXISTS zoho_invoice_id TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS zoho_invoice_id TEXT;
ALTER TABLE b2b_orders ADD COLUMN IF NOT EXISTS zoho_invoice_id TEXT;

-- Procurements — track Zoho purchase order ID
ALTER TABLE procurements ADD COLUMN IF NOT EXISTS zoho_po_id TEXT;

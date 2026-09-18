-- Migration 039: Support multiple invoices per PO
-- Adds a JSONB array column to store multiple invoice attachments
-- Format: [{ "bill_no": "INV-123", "scan_url": "https://...", "uploaded_at": "2026-..." }, ...]

ALTER TABLE procurements ADD COLUMN IF NOT EXISTS invoices JSONB DEFAULT '[]';

-- Backfill existing single invoices into the array
UPDATE procurements
SET invoices = jsonb_build_array(jsonb_build_object(
  'bill_no', COALESCE(vendor_bill_no, ''),
  'scan_url', COALESCE(bill_scan_url, ''),
  'uploaded_at', COALESCE(created_at::text, now()::text)
))
WHERE (vendor_bill_no IS NOT NULL AND vendor_bill_no != '')
   OR (bill_scan_url IS NOT NULL AND bill_scan_url != '');

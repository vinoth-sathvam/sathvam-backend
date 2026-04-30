-- migrate_016b_cleanup_duplicate_vendor_bills.sql
-- Cleanup: existing vendor bills were created per-PO but should be per-invoice.
-- This script consolidates duplicate vendor bills for same vendor+bill_no into one.
-- Run in Supabase Dashboard → SQL Editor — REVIEW each step before running.

-- STEP 1: See current duplicates (view only, no changes)
SELECT
  vendor_name,
  bill_no,
  COUNT(*) AS bill_count,
  SUM(amount) AS total_amount,
  MAX(amount) AS max_single_amount,
  MIN(bill_date) AS earliest_date,
  STRING_AGG(id::text, ', ' ORDER BY id) AS bill_ids
FROM vendor_bills
WHERE deleted_at IS NULL
GROUP BY vendor_name, bill_no
ORDER BY bill_count DESC, vendor_name;

-- STEP 2: For each duplicate group, keep only the row with the MAX amount
-- (likely the one with the full invoice amount), soft-delete the rest.
-- UNCOMMENT AND RUN after reviewing STEP 1 output.

/*
WITH ranked AS (
  SELECT
    id,
    vendor_name,
    bill_no,
    amount,
    ROW_NUMBER() OVER (
      PARTITION BY vendor_name, bill_no
      ORDER BY amount DESC, id ASC   -- keep highest-amount row, ties broken by earliest id
    ) AS rn
  FROM vendor_bills
  WHERE deleted_at IS NULL
    AND bill_no NOT LIKE 'PROC-%'     -- skip auto-generated PO bills with no real invoice_no
),
duplicates AS (
  SELECT id FROM ranked WHERE rn > 1  -- these are the extras to remove
)
UPDATE vendor_bills
SET deleted_at = NOW(), notes = COALESCE(notes,'') || ' [consolidated — duplicate of same invoice]'
WHERE id IN (SELECT id FROM duplicates);
*/

-- STEP 3: Verify the result — should show 1 row per vendor+bill_no
/*
SELECT vendor_name, bill_no, COUNT(*), MAX(amount) AS invoice_amount, status
FROM vendor_bills
WHERE deleted_at IS NULL
GROUP BY vendor_name, bill_no, status
ORDER BY vendor_name, bill_no;
*/

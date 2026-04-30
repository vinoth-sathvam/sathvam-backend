-- migrate_016_procurement_payable_link.sql
-- Adds payable_id to procurements table so raw material POs link to vendor bills
-- Run in Supabase Dashboard → SQL Editor

-- 1. Add payable_id column
ALTER TABLE procurements
  ADD COLUMN IF NOT EXISTS payable_id INTEGER REFERENCES vendor_bills(id) ON DELETE SET NULL;

-- 2. Check how many received/stocked procurements exist without a vendor bill link
-- (informational only — run separately to see count)
-- SELECT COUNT(*) FROM procurements WHERE status IN ('received','cleaned','stocked') AND payable_id IS NULL;

-- 3. (Optional) Backfill: try to match existing vendor bills to procurements
--    by vendor name + approximate amount + date proximity.
--    Only run this if you want to link existing manual bills to their POs.
--    Review the matches first before UPDATE.
/*
SELECT
  p.id AS proc_id,
  p.date AS proc_date,
  p.supplier,
  p.commodity_name,
  ROUND((p.ordered_qty * p.ordered_price_per_kg)::numeric, 2) AS calc_amount,
  vb.id AS bill_id,
  vb.bill_no,
  vb.bill_date,
  vb.amount AS bill_amount,
  vb.status AS bill_status
FROM procurements p
JOIN vendor_bills vb
  ON LOWER(vb.vendor_name) = LOWER(p.supplier)
 AND ABS(vb.amount - (p.ordered_qty * p.ordered_price_per_kg)) / GREATEST((p.ordered_qty * p.ordered_price_per_kg), 1) < 0.10
 AND vb.bill_date BETWEEN p.date - INTERVAL '7 days' AND p.date + INTERVAL '30 days'
WHERE p.status IN ('received', 'cleaned', 'stocked')
  AND p.payable_id IS NULL
  AND vb.deleted_at IS NULL
ORDER BY p.date DESC;
*/

-- 4. After reviewing the SELECT above, run UPDATE to link matched pairs:
/*
UPDATE procurements p
SET payable_id = (
  SELECT vb.id FROM vendor_bills vb
  WHERE LOWER(vb.vendor_name) = LOWER(p.supplier)
    AND ABS(vb.amount - (p.ordered_qty * p.ordered_price_per_kg)) / GREATEST((p.ordered_qty * p.ordered_price_per_kg), 1) < 0.10
    AND vb.bill_date BETWEEN p.date - INTERVAL '7 days' AND p.date + INTERVAL '30 days'
    AND vb.deleted_at IS NULL
  ORDER BY ABS(vb.amount - (p.ordered_qty * p.ordered_price_per_kg)) ASC
  LIMIT 1
)
WHERE p.status IN ('received', 'cleaned', 'stocked')
  AND p.payable_id IS NULL
  AND EXISTS (
    SELECT 1 FROM vendor_bills vb2
    WHERE LOWER(vb2.vendor_name) = LOWER(p.supplier)
      AND ABS(vb2.amount - (p.ordered_qty * p.ordered_price_per_kg)) / GREATEST((p.ordered_qty * p.ordered_price_per_kg), 1) < 0.10
      AND vb2.bill_date BETWEEN p.date - INTERVAL '7 days' AND p.date + INTERVAL '30 days'
      AND vb2.deleted_at IS NULL
  );
*/

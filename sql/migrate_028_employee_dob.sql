-- Migration 028: Add date_of_birth to employees table
-- Run in Supabase Dashboard → SQL Editor

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS date_of_birth DATE DEFAULT NULL;

COMMENT ON COLUMN employees.date_of_birth IS 'Employee date of birth — used for birthday wishes on kiosk check-in';

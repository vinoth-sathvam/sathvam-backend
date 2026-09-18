-- Migration 041: Add unique constraints for payroll pay-run upserts
-- salary_payments needs (employee_id, month) unique for ON CONFLICT
-- pay_runs needs (month) unique for ON CONFLICT

CREATE UNIQUE INDEX IF NOT EXISTS salary_payments_employee_month_uq ON salary_payments (employee_id, month);
CREATE UNIQUE INDEX IF NOT EXISTS pay_runs_month_uq ON pay_runs (month);

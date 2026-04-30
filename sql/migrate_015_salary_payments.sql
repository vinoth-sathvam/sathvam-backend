-- Salary payments: records actual salary disbursements per employee per month
CREATE TABLE IF NOT EXISTS salary_payments (
  id              SERIAL PRIMARY KEY,
  employee_id     INTEGER NOT NULL,
  employee_name   TEXT NOT NULL,
  month           TEXT NOT NULL,           -- 'YYYY-MM'
  amount          NUMERIC(12,2) NOT NULL,
  payment_mode    TEXT DEFAULT 'cash',     -- cash | bank_transfer | upi | cheque
  payment_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  reference_no    TEXT DEFAULT '',
  notes           TEXT DEFAULT '',
  paid_by         TEXT DEFAULT '',         -- admin user who recorded it
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(employee_id, month)               -- one payment record per employee per month
);

-- Pay runs: groups all employee payments for a single month into one batch
CREATE TABLE IF NOT EXISTS pay_runs (
  id              SERIAL PRIMARY KEY,
  month           TEXT NOT NULL UNIQUE,    -- 'YYYY-MM'
  total_amount    NUMERIC(12,2) NOT NULL,
  employee_count  INTEGER NOT NULL,
  payment_mode    TEXT DEFAULT 'cash',
  payment_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  reference_no    TEXT DEFAULT '',
  notes           TEXT DEFAULT '',
  created_by      TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT now()
);

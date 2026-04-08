-- ── Recurring Expenses ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recurring_expenses (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name          text NOT NULL,
  category      text DEFAULT 'other',
  amount        decimal(12,2) DEFAULT 0,
  frequency     text DEFAULT 'monthly',  -- monthly | quarterly | annual
  due_day       integer DEFAULT 1,       -- day of month (1-28)
  due_month     integer,                 -- 1-12, for annual items
  vendor        text DEFAULT '',
  notes         text DEFAULT '',
  active        boolean DEFAULT true,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recurring_payments (
  id                    uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  recurring_expense_id  uuid REFERENCES recurring_expenses(id) ON DELETE CASCADE,
  period                text NOT NULL,   -- '2025-04' | '2025-Q2' | '2025'
  paid_date             date NOT NULL,
  amount                decimal(12,2) DEFAULT 0,
  payment_mode          text DEFAULT 'bank_transfer',
  reference_no          text DEFAULT '',
  notes                 text DEFAULT '',
  created_at            timestamptz DEFAULT now(),
  UNIQUE(recurring_expense_id, period)
);

-- ── Compliance Items ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_items (
  id                   uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name                 text NOT NULL,
  type                 text DEFAULT 'other',  -- gst_monthly | gst_quarterly | tds | license | subscription | domain | fssai | other
  frequency            text DEFAULT 'annual', -- monthly | quarterly | annual | one_time
  due_day              integer DEFAULT 20,
  due_month            integer,               -- 1-12, for annual
  next_due_date        date,
  last_completed_date  date,
  cost                 decimal(12,2) DEFAULT 0,
  vendor               text DEFAULT '',
  license_no           text DEFAULT '',
  notes                text DEFAULT '',
  alert_days_before    integer DEFAULT 30,
  active               boolean DEFAULT true,
  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS compliance_history (
  id                   uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  compliance_item_id   uuid REFERENCES compliance_items(id) ON DELETE CASCADE,
  completed_date       date NOT NULL,
  period               text DEFAULT '',
  notes                text DEFAULT '',
  created_at           timestamptz DEFAULT now()
);

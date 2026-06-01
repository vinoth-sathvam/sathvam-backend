-- ─────────────────────────────────────────────────────────────────
-- Migration 029 — Universal Money Ledger + Petty Cash + CFO/CCO
-- Run in Supabase Dashboard → SQL Editor
-- ─────────────────────────────────────────────────────────────────

-- 1. Universal transaction ledger
CREATE TABLE IF NOT EXISTS money_ledger (
  id              SERIAL PRIMARY KEY,
  txn_date        DATE NOT NULL,
  txn_time        TIMESTAMPTZ DEFAULT now(),
  direction       TEXT NOT NULL CHECK (direction IN ('in','out')),
  amount          NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  category        TEXT NOT NULL DEFAULT 'other',
  subcategory     TEXT DEFAULT '',
  party           TEXT DEFAULT '',
  party_type      TEXT DEFAULT 'other',
  payment_mode    TEXT DEFAULT 'bank_transfer',
  bank_account_id UUID,
  narration       TEXT DEFAULT '',
  reference_no    TEXT DEFAULT '',
  source_table    TEXT DEFAULT '',
  source_id       TEXT DEFAULT '',
  gst_amount      NUMERIC(12,2) DEFAULT 0,
  tds_amount      NUMERIC(12,2) DEFAULT 0,
  created_by      TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS money_ledger_date_idx      ON money_ledger(txn_date DESC);
CREATE INDEX IF NOT EXISTS money_ledger_category_idx  ON money_ledger(category);
CREATE INDEX IF NOT EXISTS money_ledger_direction_idx ON money_ledger(direction);
CREATE INDEX IF NOT EXISTS money_ledger_source_idx    ON money_ledger(source_table, source_id);

-- 2. Physical petty cash box
CREATE TABLE IF NOT EXISTS petty_cash_log (
  id           SERIAL PRIMARY KEY,
  txn_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
  amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  category     TEXT DEFAULT 'expense',
  narration    TEXT NOT NULL,
  party        TEXT DEFAULT '',
  voucher_no   TEXT DEFAULT '',
  recorded_by  TEXT DEFAULT '',
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS petty_cash_date_idx ON petty_cash_log(txn_date DESC);

-- 3. CFO daily briefings archive
CREATE TABLE IF NOT EXISTS cfo_briefings (
  id          SERIAL PRIMARY KEY,
  run_date    DATE NOT NULL,
  briefing    TEXT,
  data        JSONB,
  email_sent  BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cfo_briefings_date_idx ON cfo_briefings(run_date);

-- 4. CCO findings / anomaly log
CREATE TABLE IF NOT EXISTS cco_findings (
  id           SERIAL PRIMARY KEY,
  found_at     TIMESTAMPTZ DEFAULT now(),
  severity     TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('critical','high','medium','low')),
  category     TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT DEFAULT '',
  txn_ref      TEXT DEFAULT '',
  amount       NUMERIC(12,2),
  resolved     BOOLEAN DEFAULT false,
  resolved_at  TIMESTAMPTZ,
  email_sent   BOOLEAN DEFAULT false
);

CREATE INDEX IF NOT EXISTS cco_findings_severity_idx  ON cco_findings(severity);
CREATE INDEX IF NOT EXISTS cco_findings_resolved_idx  ON cco_findings(resolved);
CREATE INDEX IF NOT EXISTS cco_findings_found_at_idx  ON cco_findings(found_at DESC);
